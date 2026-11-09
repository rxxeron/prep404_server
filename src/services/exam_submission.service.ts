import { FastifyBaseLogger } from 'fastify';
import { Pool, PoolClient } from 'pg';
import { RedisService } from '../redis/redis.service';
import { recordLearnerEvent } from './learner_analytics.service';
import { StreakService } from './streak.service';

/** Raised when the attempt could not be saved; the client should retry with the same idempotency key. */
export class SubmissionPersistenceError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SubmissionPersistenceError';
  }
}

export type QuestionOutcome = {
  questionId: string;
  selectedOption: string | null;
  correctOption: string;
  isCorrect: boolean;
  explanation?: string;
};

export interface ExamAttempt {
  examId: string;
  /** Verified learner ID (guests are never persisted). */
  userId: string;
  /** False for practice, overtime, or any attempt that must not be ranked. */
  wantsRanked: boolean;
  answers: Record<string, string>;
  score: number;
  correctCount: number;
  wrongCount: number;
  unansweredCount: number;
  timeTakenSeconds: number;
  idempotencyKey: string | null;
  candidateName: string;
  candidateInstitution: string;
  universityCode: string;
  outcomes: QuestionOutcome[];
  /** Add wrong answers to the learner's spaced-repetition mistake vault. */
  recordMistakes: boolean;
  questionsSnapshot?: any[];
}

export interface PersistedAttempt {
  submissionId: string;
  isPractice: boolean;
  /** Live rank, or null for practice attempts or when ranking is unavailable. */
  rank: number | null;
  totalCandidates: number;
}

const INSERT_SUBMISSION = `
  INSERT INTO exam_submissions (
    exam_id, user_id, answers, score, correct_count,
    wrong_count, unanswered_count, time_taken_seconds, rank,
    idempotency_key, is_practice, candidate_name, candidate_institution, university_code,
    questions_snapshot
  ) VALUES ($1::uuid, $2::uuid, $3::jsonb, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12, $13, $14::jsonb)
  RETURNING id;`;

const INSERT_OUTCOMES = `INSERT INTO public.exam_submission_answers
    (submission_id, question_id, subject_id, topic_id, selected_option, correct_option, outcome)
  SELECT $1::uuid, item.question_id::uuid, q.subject_id, q.topic_id,
    item.selected_option, item.correct_option, item.outcome
  FROM jsonb_to_recordset($2::jsonb) AS item(
    question_id text, selected_option text, correct_option text, outcome text
  )
  JOIN public.questions q ON q.id=item.question_id::uuid
  ON CONFLICT (submission_id, question_id) DO NOTHING`;

const UPSERT_MISTAKES = `INSERT INTO mistake_vault (
    user_id, question_id, student_wrong_option, correct_option, explanation, due_at
  )
  SELECT $1::uuid, item.question_id::uuid, item.wrong_option, item.correct_option, item.explanation, NOW() + INTERVAL '1 day'
  FROM jsonb_to_recordset($2::jsonb) AS item(
    question_id text, wrong_option text, correct_option text, explanation text
  )
  ON CONFLICT (user_id, question_id) DO UPDATE SET
    student_wrong_option = EXCLUDED.student_wrong_option,
    correct_option = EXCLUDED.correct_option,
    explanation = EXCLUDED.explanation,
    due_at = NOW() + INTERVAL '1 day'`;

/** Run an optional write inside a savepoint so its failure cannot undo the submission. */
async function bestEffort(client: PoolClient, log: FastifyBaseLogger, name: string, sql: string, values: unknown[]) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    await client.query(sql, values);
    await client.query(`RELEASE SAVEPOINT ${name}`);
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    log.warn({ err }, `Optional exam write "${name}" was skipped`);
  }
}

/**
 * Save one learner's exam attempt: the submission row, per-question outcomes
 * and (optionally) mistake-vault entries in one transaction, then rank it.
 *
 * One ranked attempt per learner and exam is enforced by a unique index. A
 * learner who already has one, or who loses a concurrent race for it, gets a
 * saved practice attempt instead.
 */
export async function persistExamAttempt(
  db: Pool,
  redis: RedisService,
  log: FastifyBaseLogger,
  attempt: ExamAttempt,
): Promise<PersistedAttempt> {
  let isPractice = !attempt.wantsRanked;
  if (!isPractice) {
    const existing = await db.query(
      `SELECT id FROM exam_submissions WHERE exam_id = $1::uuid AND user_id = $2::uuid AND is_practice = false LIMIT 1`,
      [attempt.examId, attempt.userId],
    );
    if (existing.rows.length > 0) isPractice = true;
  }

  const insertValues = (practice: boolean, idempotencyKey: string | null) => [
    attempt.examId,
    attempt.userId,
    JSON.stringify(attempt.answers),
    attempt.score,
    attempt.correctCount,
    attempt.wrongCount,
    attempt.unansweredCount,
    attempt.timeTakenSeconds,
    idempotencyKey,
    practice,
    attempt.candidateName,
    attempt.candidateInstitution,
    attempt.universityCode,
    attempt.questionsSnapshot ? JSON.stringify(attempt.questionsSnapshot) : null,
  ];

  let submissionId: string;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let saved;
    if (isPractice) {
      saved = await client.query(INSERT_SUBMISSION, insertValues(true, attempt.idempotencyKey));
    } else {
      await client.query('SAVEPOINT ranked_insert');
      try {
        saved = await client.query(INSERT_SUBMISSION, insertValues(false, attempt.idempotencyKey));
        await client.query('RELEASE SAVEPOINT ranked_insert');
      } catch (err: any) {
        if (err?.code !== '23505') throw err;
        // A concurrent request already took this learner's ranked attempt.
        await client.query('ROLLBACK TO SAVEPOINT ranked_insert');
        isPractice = true;
        saved = await client.query(INSERT_SUBMISSION, insertValues(true, null));
      }
    }
    submissionId = saved.rows[0]?.id;
    if (!submissionId) throw new Error('Submission insert returned no record ID');

    await bestEffort(client, log, 'question_outcomes', INSERT_OUTCOMES, [submissionId, JSON.stringify(attempt.outcomes.map((item) => ({
      question_id: item.questionId,
      selected_option: item.selectedOption,
      correct_option: item.correctOption,
      outcome: item.selectedOption == null ? 'skipped' : item.isCorrect ? 'correct' : 'wrong',
    })))]);

    if (attempt.recordMistakes) {
      const mistakes = attempt.outcomes
        .filter((item) => item.selectedOption && !item.isCorrect)
        .map((item) => ({
          question_id: item.questionId,
          wrong_option: item.selectedOption,
          correct_option: item.correctOption,
          explanation: item.explanation ?? null,
        }));
      if (mistakes.length) {
        await bestEffort(client, log, 'mistake_vault', UPSERT_MISTAKES, [attempt.userId, JSON.stringify(mistakes)]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    log.error({ err, examId: attempt.examId }, 'Exam submission persistence failed');
    throw new SubmissionPersistenceError('The submission could not be saved. Retry with the same idempotency key.', err);
  } finally {
    client.release();
  }

  if (isPractice) {
    return { submissionId, isPractice, rank: null, totalCandidates: (await redis.getExamTotalParticipants(attempt.examId)) || 1 };
  }

  try { await recordLearnerEvent(db, attempt.userId, 'exam_submitted'); }
  catch (err) { log.warn({ err, examId: attempt.examId }, 'Optional exam analytics event was not recorded'); }

  // Record daily streak activity and update DB timeline
  try {
    const streakService = new StreakService(db);
    const qCount = attempt.outcomes.length || (attempt.correctCount + attempt.wrongCount + attempt.unansweredCount) || 10;
    await streakService.recordActivity(attempt.userId, qCount, 1);
  } catch (err) {
    log.warn({ err, userId: attempt.userId }, 'Optional streak update was not recorded');
  }

  // The submission is already saved; a ranking outage must not turn it into an error.
  try {
    const member = `user:${attempt.userId}`;
    await redis.submitExamScore(attempt.examId, member, `${attempt.candidateName} (${attempt.candidateInstitution})`, attempt.score, attempt.timeTakenSeconds);
    const rankInfo = await redis.getUserExamRank(attempt.examId, member);
    try {
      await db.query('UPDATE exam_submissions SET rank=$1 WHERE id=$2::uuid', [rankInfo.rank, submissionId]);
    } catch (err) {
      log.error({ err, examId: attempt.examId, submissionId }, 'Exam submission rank persistence failed');
    }
    return { submissionId, isPractice: false, rank: rankInfo.rank, totalCandidates: rankInfo.totalCandidates };
  } catch (err) {
    log.error({ err, examId: attempt.examId, submissionId }, 'Live ranking unavailable; submission saved without a rank');
    return { submissionId, isPractice: false, rank: null, totalCandidates: 1 };
  }
}
