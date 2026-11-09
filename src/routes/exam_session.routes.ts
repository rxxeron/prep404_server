import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { RedisService } from '../redis/redis.service';
import { sendInternalError } from '../services/http_errors';
import type { ExamRouteOptions } from './exam.routes';
import { z } from 'zod';
import { createHash, randomUUID } from 'crypto';
import { registerExamSubmissionIdempotency } from '../services/exam_idempotency.service';
import { ExamScoringService } from '../services/exam_scoring.service';
import { hashExamSessionId, recordExamSessionCompletion, recordExamSessionFailure, recordExamSessionStart } from '../services/exam_session_telemetry.service';
import { persistExamAttempt, PersistedAttempt, SubmissionPersistenceError } from '../services/exam_submission.service';
import { resolveCandidateIdentity } from '../services/learner_identity.service';
import { recordLearnerEvent } from '../services/learner_analytics.service';

/** Server-owned exam sessions (option scrambling) and scored submissions. */
export const examSessionRoutes: FastifyPluginAsync<ExamRouteOptions> = async (
  app: FastifyInstance,
  opts: ExamRouteOptions,
) => {
  const { db, redis } = opts;

  const examSessionOwnerKey = (examId: string, sessionId: string) => `session-owner:${examId}:${sessionId}`;
  const examSessionOwnerTag = (userId: string | null) => userId
    ? `user:${createHash('sha256').update(userId).digest('hex')}`
    : 'anonymous';
  const examSessionOwnerMatches = (ownerTag: string | null, userId: string | null) => {
    if (ownerTag === 'anonymous') return userId === null;
    return !!ownerTag && !!userId && ownerTag === examSessionOwnerTag(userId);
  };

  registerExamSubmissionIdempotency(app, redis, async (req) => (await resolveCandidateIdentity(req)).userId);

  // =========================================================================
  // 9. DYNAMIC EXAM SESSION GENERATOR (ANTI-CHEAT OPTION SCRAMBLING)
  // =========================================================================
  app.get('/api/v1/exam/:id/dynamic-session', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id: examId } = req.params;
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });

    try {
      // 1. Fetch exam metadata
      const examRes = await db.query(`
        SELECT e.id, e.title, e.track, ROUND(e.duration_seconds / 60) AS "durationMinutes",
               e.total_marks AS "totalMarks", COALESCE(e.negative_mark_per_question, 0.25) AS "negativeMarking",
               (SELECT COUNT(*)::int FROM public.exam_questions linked WHERE linked.exam_id=e.id) AS "linkedQuestionCount",
               u.code AS "universityCode", u.full_name AS "universityName", u.logo_url AS "universityLogo"
        FROM exams e
        LEFT JOIN universities u ON u.id = e.target_university_id
        WHERE e.id = $1::uuid AND e.is_active = true
          AND (e.starts_at IS NULL OR e.starts_at <= now())
          AND (e.ends_at IS NULL OR e.ends_at > now());
      `, [examId]);

      if (examRes.rows.length === 0) {
        return reply.status(404).send({ error: 'Exam not found' });
      }
      const exam = examRes.rows[0];

      // 2. Fetch questions in strict authored order, joining stimuli for reading passages
      const qRes = await db.query(`
        SELECT eq.question_order AS "order", q.id, q.stem_primary AS "questionText",
               (q.stem_primary LIKE '%$%' OR q.stem_primary LIKE '%\\%') AS "hasMath",
               q.options, q.difficulty_rating AS "difficultyRating", s.name AS "subjectName",
               q.is_active AS "isActive", q.review_status AS "reviewStatus", q.topic_id AS "topicId",
               q.solution_markdown AS "solutionMarkdown",
               qs.content_text AS "passage",
               q.context_snippet AS "contextSnippet"
        FROM exam_questions eq
        JOIN questions q ON q.id = eq.question_id
        LEFT JOIN academic_subjects s ON s.id = q.subject_id
        LEFT JOIN question_stimuli qs ON qs.id = q.stimulus_id
        WHERE eq.exam_id = $1::uuid
        ORDER BY eq.question_order ASC;
      `, [examId]);

      const linkedQuestionCount = Number(exam.linkedQuestionCount);
      const hasUnreadyQuestion = qRes.rows.some((row) => {
        const options = Array.isArray(row.options) ? row.options : [];
        const correctOptions = options.filter((option: any) => option?.is_correct === true || option?.is_correct === 'true');
        return row.isActive !== true
          || row.reviewStatus !== 'approved'
          || !row.topicId
          || String(row.questionText || '').trim().length < 5
          || String(row.solutionMarkdown || '').trim().length < 3
          || options.length < 2
          || correctOptions.length !== 1;
      });
      if (!qRes.rows.length || qRes.rows.length !== linkedQuestionCount || hasUnreadyQuestion) {
        return reply.status(409).send({ error: 'This exam question set is not ready to start. Please choose another exam or contact support.' });
      }

      const sessionId = randomUUID();
      const scrambledKeyMap: Record<string, string> = {};

      const relationalOptionPattern = /\b(all|none)\s+of\s+the\s+(above|below|mentioned)|above\s+all|none\s+of\s+these|all\s+of\s+these|\bboth\s+(\([a-d]\)|[a-d])\s+and\s+(\([a-d]\)|[a-d])\b|\bboth\s+(a\s+and\s+b|b\s+and\s+c|a\s+and\s+c)\b/i;

      const clientQuestions = qRes.rows.map((row) => {
        const rawOpts = Array.isArray(row.options) ? [...row.options] : [];
        const hasRelational = rawOpts.some((opt: any) => relationalOptionPattern.test(opt?.text || ''));

        // Fisher-Yates shuffle options unless relational option text is present
        if (!hasRelational) {
          for (let i = rawOpts.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rawOpts[i], rawOpts[j]] = [rawOpts[j], rawOpts[i]];
          }
        }

        let newCorrectLetter = 'A';
        const scrambledOptions = rawOpts.map((opt: any, idx: number) => {
          const assignedLetter = String.fromCharCode(65 + idx);
          if (opt.is_correct) newCorrectLetter = assignedLetter;
          return {
            id: assignedLetter,
            text: opt.text || '',
          };
        });

        scrambledKeyMap[row.id] = newCorrectLetter;

        return {
          id: row.id,
          order: row.order,
          subject: row.subjectName || 'General',
          questionText: row.questionText,
          passage: row.passage || null,
          contextSnippet: row.contextSnippet || null,
          hasMath: row.hasMath,
          options: scrambledOptions, // Stripped is_correct and scrambled!
          difficultyRating: parseFloat(row.difficultyRating || '1.0'),
        };
      });

      // Save student session mapping in Redis with 2 hours TTL
      try {
        await redis.setSessionKey(`session:${examId}:${sessionId}`, JSON.stringify(scrambledKeyMap), 7200);
        await redis.setSessionKey(examSessionOwnerKey(examId, sessionId), examSessionOwnerTag(identity.userId), 7200);
        await recordExamSessionStart(db, examId, sessionId, 'dynamic');
      } catch (err) {
        await Promise.all([
          redis.del(`session:${examId}:${sessionId}`).catch(() => undefined),
          redis.del(examSessionOwnerKey(examId, sessionId)).catch(() => undefined),
        ]);
        req.log.error({ err, examId }, 'Unable to record dynamic exam session start');
        return reply.status(503).send({ error: 'Unable to initialize an exam session. Please try again.' });
      }

      return {
        success: true,
        sessionId,
        examId,
        exam,
        totalQuestions: clientQuestions.length,
        questions: clientQuestions,
      };
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // 3. Exam Score Submission & Live Redis Ranking
  const SubmitExamSchema = z.object({
    userId: z.string().uuid().optional(),
    sessionId: z.string().uuid().optional(),
    candidateName: z.string().optional().default('Candidate'),
    candidateInstitution: z.string().optional().default('Institution'),
    universityCode: z.string().optional(),
    isPractice: z.boolean().optional().default(false),
    answers: z.record(z.string()),
    timeTakenSeconds: z.number().positive(),
    questionsSnapshot: z.array(z.any()).optional(),
  });

  app.post('/api/v1/exam/:id/submit', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id: examId } = req.params;
    const parse = SubmitExamSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.errors[0].message });
    }

    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });
    if (identity.userId && parse.data.userId && parse.data.userId !== identity.userId) {
      return reply.status(403).send({ error: 'Submission account does not match the signed-in user.' });
    }
    const userId = identity.userId || '';
    let candidateName = parse.data.candidateName;
    let candidateInstitution = parse.data.candidateInstitution;
    const { answers, timeTakenSeconds } = parse.data;
    const submittedSessionId = parse.data.sessionId || null;
    let authoritativeTimeTaken = timeTakenSeconds;

    if (identity.userId) {
      if (!submittedSessionId && !parse.data.isPractice) {
        return reply.status(403).send({ error: 'Start this exam before submitting a ranked attempt.' });
      }
      if (submittedSessionId) {
        let ownerTag: string | null;
        try { ownerTag = await redis.getSessionKey(examSessionOwnerKey(examId, submittedSessionId)); }
        catch (err) {
          req.log.error({ err, examId }, 'Exam session ownership could not be verified');
          return reply.status(503).send({ error: 'Exam session verification is temporarily unavailable.' });
        }
        if (!examSessionOwnerMatches(ownerTag, identity.userId)) {
          return reply.status(403).send({ error: 'This exam session is invalid or belongs to another learner.' });
        }
        const sessionRes = await db.query(
          `SELECT GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - started_at)))::int) AS elapsed_seconds,
                  submitted_at FROM public.exam_session_telemetry
            WHERE session_hash = $1 AND exam_id = $2::uuid LIMIT 1`,
          [hashExamSessionId(submittedSessionId), examId]
        );
        if (!sessionRes.rowCount) return reply.status(403).send({ error: 'This exam session is invalid or expired. Start the exam again.' });
        if (sessionRes.rows[0].submitted_at) return reply.status(409).send({ error: 'This exam session has already been submitted.' });
        authoritativeTimeTaken = Number(sessionRes.rows[0].elapsed_seconds);
      }
    }
    const idempotencyKey = typeof req.headers['idempotency-key'] === 'string'
      ? req.headers['idempotency-key']
      : null;

    try {
      if (identity.userId) {
        const profile = await db.query('SELECT full_name, institution_name FROM public.users WHERE id=$1::uuid', [identity.userId]);
        if (!profile.rowCount) return reply.status(403).send({ error: 'Complete your learner profile before submitting a ranked exam.' });
        candidateName = profile.rows[0].full_name || candidateName;
        candidateInstitution = profile.rows[0].institution_name || candidateInstitution;
      }

      // 1. Fetch exam metadata
      const isExamUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(examId);
      let examRes;
      if (isExamUuid) {
        examRes = await db.query(`SELECT * FROM exams WHERE id = $1::uuid AND is_active = true
          AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())`, [examId]);
      } else {
        if (examId.startsWith('daily-')) {
          const uCode = examId.replace(/^daily-/, '').replace(/-live$/, '');
          examRes = await db.query(`
            SELECT e.* FROM exams e 
            JOIN universities u ON u.id = e.target_university_id 
            WHERE LOWER(u.code) = LOWER($1) AND e.is_active = true 
            ORDER BY e.created_at DESC LIMIT 1
          `, [uCode]);
        } else {
          examRes = await db.query(`SELECT * FROM exams WHERE (id::text = $1 OR title ILIKE $1) AND is_active = true
            AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())`, [examId]);
        }
      }

      if (examRes.rows.length === 0) {
        return reply.status(404).send({ error: 'Exam not found' });
      }
      const exam = examRes.rows[0];
      const authoritativeExamId = exam.id;

      // 2. Fetch real questions and correct answers for this exam
      const qRes = await db.query(`
        SELECT q.id, q.options, q.solution_markdown
        FROM exam_questions eq
        JOIN questions q ON q.id = eq.question_id
        WHERE eq.exam_id = $1::uuid
        ORDER BY eq.question_order ASC;
      `, [authoritativeExamId]);

      const evaluation = ExamScoringService.evaluateSubmission({
        questions: qRes.rows,
        answers,
        totalMarks: exam.total_marks,
        negativeMarkPerQuestion: exam.negative_mark_per_question ?? 0.25,
        timeTakenSeconds: authoritativeTimeTaken,
      });

      // Anti-Cheat Check 1: Minimum realistic completion time (at least 0.5s per question to prevent automated bot scripts)
      if (evaluation.isSuspiciousSpeed) {
        return reply.status(400).send({ 
          error: 'Submission rejected: completion time is unnaturally low. Automated script detected.',
          code: 'SUSPICIOUS_SPEED'
        });
      }

      if (identity.userId) {
        if (typeof redis.recordQuestionTelemetryBatch === 'function') {
          await redis.recordQuestionTelemetryBatch(examId, evaluation.feedback);
        } else if (typeof redis.recordQuestionTelemetry === 'function') {
          for (const item of evaluation.feedback) {
            if (item.selectedOption) {
              await redis.recordQuestionTelemetry(examId, item.questionId, item.selectedOption);
            }
          }
        }
      }

      const { score, correctCount, wrongCount, unansweredCount, xpGained, feedback } = evaluation;

      // Anti-Cheat Check 2: Overtime check against duration + 120s network grace period
      const maxAllowedSeconds = (exam.duration_seconds || 1800) + 120;
      let isOvertime = false;
      if (authoritativeTimeTaken > maxAllowedSeconds) {
        // Late submissions outside allowed exam duration cannot be officially ranked
        isOvertime = true;
      }

      // Only verified learners are saved and ranked; guests get an unranked score.
      let persisted: PersistedAttempt | null = null;
      if (identity.userId) {
        const clientSnapshot = parse.data.questionsSnapshot;
        let attemptSnapshot: any[] = [];
        if (Array.isArray(clientSnapshot) && clientSnapshot.length > 0) {
          const fbMap = new Map(feedback.map((f) => [f.questionId, f]));
          attemptSnapshot = clientSnapshot.map((cq: any) => {
            const fb = fbMap.get(cq.id);
            const ansKey = fb?.correctOption || cq.correctOptionId || cq.correct_option_id || '';
            return {
              id: cq.id,
              text: cq.text || cq.questionText || '',
              questionText: cq.questionText || cq.text || '',
              passage: cq.passage || null,
              contextSnippet: cq.contextSnippet || null,
              hasMath: Boolean(cq.hasMath || cq.has_math),
              options: cq.options || [],
              correctOptionId: ansKey,
              correct_option_id: ansKey,
              explanation: fb?.explanation || cq.explanation || '',
              userAnswer: answers[cq.id] ?? null,
            };
          });
        }

        try {
          persisted = await persistExamAttempt(db, redis, req.log, {
            examId,
            userId: identity.userId,
            wantsRanked: !parse.data.isPractice && !isOvertime,
            answers,
            score,
            correctCount,
            wrongCount,
            unansweredCount,
            timeTakenSeconds: authoritativeTimeTaken,
            idempotencyKey,
            candidateName,
            candidateInstitution,
            universityCode: parse.data.universityCode || exam.track || 'GEN',
            outcomes: feedback.map((item) => ({
              questionId: item.questionId,
              selectedOption: item.selectedOption,
              correctOption: item.correctOption,
              isCorrect: item.isCorrect,
              explanation: item.explanation,
            })),
            recordMistakes: false,
            questionsSnapshot: attemptSnapshot.length > 0 ? attemptSnapshot : undefined,
          });
        } catch (err) {
          if (err instanceof SubmissionPersistenceError) {
            return reply.status(503).send({ error: err.message, code: 'SUBMISSION_PERSISTENCE_FAILED' });
          }
          throw err;
        }
      }
      const isPracticeMode = persisted ? persisted.isPractice : true;
      const liveRank = persisted?.rank ?? 0;
      const totalParticipants = persisted ? persisted.totalCandidates : ((await redis.getExamTotalParticipants(examId)) || 1);

      if (submittedSessionId && identity.userId) {
        await recordExamSessionCompletion(db, examId, submittedSessionId).catch((err) =>
          req.log.warn({ err, examId }, 'Unable to record exam session completion')
        );
      }

      return {
        success: true,
        submissionPersisted: Boolean(persisted),
        examId,
        userId,
        score,
        totalMarks: exam.total_marks,
        correctCount,
        wrongCount,
        unansweredCount,
        timeTakenSeconds: authoritativeTimeTaken,
        liveRank,
        totalParticipants,
        isPractice: isPracticeMode,
        xpGained,
        feedback,
      };
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 10. SUBMIT DYNAMIC EXAM SESSION (ANTI-CHEAT DE-SCRAMBLE & MISTAKE VAULT)
  // =========================================================================
  const SubmitDynamicSessionSchema = z.object({
    sessionId: z.string().uuid(),
    userId: z.string().uuid().optional(),
    isPractice: z.boolean().optional().default(false),
    candidateName: z.string().default('Student Candidate'),
    candidateInstitution: z.string().default('Prep404 Arena'),
    answers: z.record(z.string()),
    timeTakenSeconds: z.number().positive(),
    questionsSnapshot: z.array(z.any()).optional(),
  });

  app.post('/api/v1/exam/:id/submit-session', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id: examId } = req.params;
    const parse = SubmitDynamicSessionSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.errors[0].message });
    }

    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });
    if (identity.userId && parse.data.userId && parse.data.userId !== identity.userId) {
      return reply.status(403).send({ error: 'Submission account does not match the signed-in user.' });
    }
    const { sessionId, answers, timeTakenSeconds } = parse.data;
    const userId = identity.userId;
    let ownerTag: string | null;
    try { ownerTag = await redis.getSessionKey(examSessionOwnerKey(examId, sessionId)); }
    catch (err) {
      req.log.error({ err, examId }, 'Exam session ownership could not be verified');
      return reply.status(503).send({ error: 'Exam session verification is temporarily unavailable.' });
    }
    if (!ownerTag) return reply.status(403).send({ error: 'This exam session is invalid or expired. Start the exam again.' });
    if (ownerTag.startsWith('user:') && !userId) return reply.status(401).send({ error: 'Sign in with the learner account that started this exam.' });
    if (!examSessionOwnerMatches(ownerTag, userId)) {
      return reply.status(403).send({ error: 'This exam session belongs to another learner.' });
    }
    let candidateName = parse.data.candidateName;
    let candidateInstitution = parse.data.candidateInstitution;
    const idempotencyKey = typeof req.headers['idempotency-key'] === 'string'
      ? req.headers['idempotency-key']
      : null;

    try {
      if (identity.userId) {
        const profile = await db.query('SELECT full_name, institution_name FROM public.users WHERE id=$1::uuid', [identity.userId]);
        if (!profile.rowCount) return reply.status(403).send({ error: 'Complete your learner profile before submitting a ranked exam.' });
        candidateName = profile.rows[0].full_name || candidateName;
        candidateInstitution = profile.rows[0].institution_name || candidateInstitution;
      }

      // 1. Fetch key map from Redis
      const cachedMapStr = await redis.getSessionKey(`session:${examId}:${sessionId}`);
      if (!cachedMapStr) return reply.status(403).send({ error: 'This exam session is invalid or expired. Start the exam again.' });
      let scrambledKeyMap: Record<string, string>;
      try {
        scrambledKeyMap = JSON.parse(cachedMapStr);
        if (!scrambledKeyMap || typeof scrambledKeyMap !== 'object' || Array.isArray(scrambledKeyMap)) {
          return reply.status(403).send({ error: 'This exam session is invalid or expired. Start the exam again.' });
        }
      } catch (_) {
        return reply.status(403).send({ error: 'This exam session is invalid or expired. Start the exam again.' });
      }

      // 2. Fetch exam info
      const isExamUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(examId);
      let examRes;
      if (isExamUuid) {
        examRes = await db.query(`SELECT * FROM exams WHERE id = $1::uuid AND is_active = true
          AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())`, [examId]);
      } else {
        if (examId.startsWith('daily-')) {
          const uCode = examId.replace(/^daily-/, '').replace(/-live$/, '');
          examRes = await db.query(`
            SELECT e.* FROM exams e 
            JOIN universities u ON u.id = e.target_university_id 
            WHERE LOWER(u.code) = LOWER($1) AND e.is_active = true 
            ORDER BY e.created_at DESC LIMIT 1
          `, [uCode]);
        } else {
          examRes = await db.query(`SELECT * FROM exams WHERE (id::text = $1 OR title ILIKE $1) AND is_active = true
            AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())`, [examId]);
        }
      }

      if (examRes.rows.length === 0) {
        return reply.status(404).send({ error: 'Exam not found' });
      }
      const exam = examRes.rows[0];
      const authoritativeExamId = exam.id;

      const sessionRes = await db.query(
        `SELECT GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - started_at)))::int) AS elapsed_seconds,
                submitted_at FROM public.exam_session_telemetry
          WHERE session_hash = $1 AND exam_id = $2::uuid LIMIT 1`,
        [hashExamSessionId(sessionId), authoritativeExamId]
      );
      if (!sessionRes.rowCount) return reply.status(403).send({ error: 'This exam session is invalid or expired. Start the exam again.' });
      if (sessionRes.rows[0].submitted_at) return reply.status(409).send({ error: 'This exam session has already been submitted.' });
      const authoritativeTimeTaken = Number(sessionRes.rows[0].elapsed_seconds);

      // 3. Fetch questions with explanations
      const qRes = await db.query(`
        SELECT q.id, q.stem_primary AS "questionText", q.options, q.solution_markdown AS "explanation",
               s.name AS "subjectName"
        FROM exam_questions eq
        JOIN questions q ON q.id = eq.question_id
        LEFT JOIN academic_subjects s ON s.id = q.subject_id
        WHERE eq.exam_id = $1::uuid
        ORDER BY eq.question_order ASC;
      `, [authoritativeExamId]);

      let correctCount = 0;
      let wrongCount = 0;
      let unansweredCount = 0;
      const totalQuestions = qRes.rows.length || 1;
      const markPerQ = exam.total_marks / totalQuestions;
      const negMark = exam.negative_mark_per_question ?? 0.25;
      const reviewFeedback: any[] = [];

      // Anti-Cheat Check 1: Minimum realistic completion time (at least 0.5s per question to prevent automated bot scripts)
      if (ExamScoringService.isSubmissionSuspiciouslyFast(authoritativeTimeTaken, totalQuestions)) {
        if (sessionId) {
          await recordExamSessionFailure(db, examId, sessionId, 'suspicious_speed').catch(() => undefined);
        }
        return reply.status(400).send({
          error: 'Submission rejected: completion time is unnaturally low. Automated script detected.',
          code: 'SUSPICIOUS_SPEED',
        });
      }

      for (const q of qRes.rows) {
        let expectedCorrectLetter = scrambledKeyMap[q.id];
        if (!expectedCorrectLetter) {
          const rawOpts = Array.isArray(q.options) ? q.options : [];
          rawOpts.forEach((opt: any, idx: number) => {
            if (opt.is_correct) expectedCorrectLetter = opt.key_original || String.fromCharCode(65 + idx);
          });
        }

        const studentChoice = answers[q.id];
        let isCorrect = false;

        if (!studentChoice) {
          unansweredCount++;
        } else if (studentChoice === expectedCorrectLetter) {
          correctCount++;
          isCorrect = true;
        } else {
          wrongCount++;
        }

        // Auto-record wrong question into student mistake vault
        if (!isCorrect && studentChoice && userId && userId.includes('-')) {
          try {
            const uCode = (exam.universityCode || exam.track || 'gen').toLowerCase();
            await db.query(`
              INSERT INTO mistake_vault (
                user_id, question_id, university_code, wrong_count, next_review_at, is_mastered, last_reviewed_at
              ) VALUES ($1::uuid, $2::uuid, $3, 1, NOW() + INTERVAL '1 day', false, NOW())
              ON CONFLICT (user_id, question_id) DO UPDATE SET
                wrong_count = mistake_vault.wrong_count + 1,
                is_mastered = false,
                next_review_at = NOW() + INTERVAL '1 day',
                last_reviewed_at = NOW();
            `, [userId, q.id, uCode]);
          } catch (mvErr) {
            req.log.warn({ err: mvErr, userId, questionId: q.id }, 'Unable to record mistake in vault');
          }
        }

        reviewFeedback.push({
          questionId: q.id,
          questionText: q.questionText,
          subject: q.subjectName || 'General',
          studentAnswer: studentChoice || null,
          selectedOption: studentChoice || null,
          correctAnswer: expectedCorrectLetter,
          correctOption: expectedCorrectLetter,
          isCorrect,
          explanation: q.explanation || '',
        });
      }

      const rawScore = correctCount * markPerQ - wrongCount * negMark;
      const score = Math.max(0, parseFloat(rawScore.toFixed(2)));
      const candidateKey = `${candidateName} (${candidateInstitution})`; // display name only
      const validUserId = Boolean(identity.userId);

      // Anti-Cheat Check 2: Overtime check against duration + 120s network grace period
      const maxAllowedSeconds = (exam.duration_seconds || 1800) + 120;
      let isPracticeMode = parse.data.isPractice || !validUserId;
      if (authoritativeTimeTaken > maxAllowedSeconds) {
        isPracticeMode = true;
      }
      if (validUserId && !isPracticeMode) {
        const existingSubmission = await db.query(
          `SELECT id FROM exam_submissions WHERE exam_id = $1::uuid AND user_id = $2::uuid AND is_practice = false LIMIT 1`,
          [examId, userId]
        );
        if (existingSubmission.rows.length > 0) {
          isPracticeMode = true;
        }
      }

      let submissionId: string | null = null;
      if (validUserId) {
        const fbMap = new Map(reviewFeedback.map((f: any) => [f.questionId, f]));
        let attemptSnapshot: any[] = [];
        if (Array.isArray(parse.data.questionsSnapshot) && parse.data.questionsSnapshot.length > 0) {
          attemptSnapshot = parse.data.questionsSnapshot.map((cq: any) => {
            const fb = fbMap.get(cq.id);
            const ansKey = fb?.correctAnswer || cq.correctOptionId || cq.correct_option_id || '';
            return {
              id: cq.id,
              text: cq.text || cq.questionText || '',
              questionText: cq.questionText || cq.text || '',
              passage: cq.passage || null,
              contextSnippet: cq.contextSnippet || null,
              hasMath: Boolean(cq.hasMath || cq.has_math),
              options: cq.options || [],
              correctOptionId: ansKey,
              correct_option_id: ansKey,
              explanation: fb?.explanation || cq.explanation || '',
              userAnswer: answers[cq.id] ?? null,
            };
          });
        } else {
          attemptSnapshot = qRes.rows.map((row: any) => {
            const fb = fbMap.get(row.id);
            const rawOpts = Array.isArray(row.options) ? row.options : [];
            let detectedCorrect = 'A';
            const formattedOptions = rawOpts.map((opt: any, idx: number) => {
              const letter = opt.key_original || String.fromCharCode(65 + idx);
              if (opt.is_correct) detectedCorrect = letter;
              return {
                id: letter,
                text: opt.text || '',
                has_math: Boolean(opt.has_math || opt.hasMath),
              };
            });
            const ansKey = fb?.correctAnswer || detectedCorrect;
            return {
              id: row.id,
              text: row.questionText || '',
              questionText: row.questionText || '',
              passage: row.passage || null,
              contextSnippet: row.contextSnippet || null,
              hasMath: row.hasMath,
              options: formattedOptions,
              correctOptionId: ansKey,
              correct_option_id: ansKey,
              explanation: fb?.explanation || row.explanation || '',
              userAnswer: answers[row.id] ?? null,
            };
          });
        }
        const snapshotJson = attemptSnapshot.length > 0 ? JSON.stringify(attemptSnapshot) : null;

        try {
          const saved = await db.query(`
            INSERT INTO exam_submissions (
              exam_id, user_id, answers, score, correct_count,
              wrong_count, unanswered_count, time_taken_seconds, rank,
              idempotency_key, is_practice, candidate_name, candidate_institution, university_code,
              questions_snapshot
            ) VALUES ($1::uuid, $2::uuid, $3::jsonb, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12, $13, $14::jsonb)
            RETURNING id;
          `, [
            examId,
            userId,
            JSON.stringify(answers),
            score,
            correctCount,
            wrongCount,
            unansweredCount,
            authoritativeTimeTaken,
            idempotencyKey,
            isPracticeMode,
            candidateName,
            candidateInstitution,
            exam.track || 'GEN',
            snapshotJson
          ]);
          submissionId = saved.rows[0]?.id || null;
          if (!submissionId) throw new Error('Submission insert returned no record ID');
          try {
            await db.query(`INSERT INTO public.exam_submission_answers
                (submission_id, question_id, subject_id, topic_id, selected_option, correct_option, outcome)
              SELECT $1::uuid, item.question_id::uuid, q.subject_id, q.topic_id,
                item.selected_option, item.correct_option, item.outcome
              FROM jsonb_to_recordset($2::jsonb) AS item(
                question_id text, selected_option text, correct_option text, outcome text
              )
              JOIN public.questions q ON q.id=item.question_id::uuid
              ON CONFLICT (submission_id, question_id) DO NOTHING`, [submissionId, JSON.stringify(reviewFeedback.map((item) => ({
                question_id: item.questionId,
                selected_option: item.studentAnswer,
                correct_option: item.correctAnswer,
                outcome: item.studentAnswer == null ? 'skipped' : item.isCorrect ? 'correct' : 'wrong',
              })))]);
          } catch (telemetryError) {
            req.log.warn({ err: telemetryError, examId }, 'Dynamic question outcome snapshot was not persisted');
          }
        } catch (err: any) {
          if (err?.code === '23505' && !isPracticeMode) {
            isPracticeMode = true;
            try {
              const fallbackSaved = await db.query(`
                INSERT INTO exam_submissions (
                  exam_id, user_id, answers, score, correct_count,
                  wrong_count, unanswered_count, time_taken_seconds, rank,
                  idempotency_key, is_practice, candidate_name, candidate_institution, university_code,
                  questions_snapshot
                ) VALUES ($1::uuid, $2::uuid, $3::jsonb, $4, $5, $6, $7, $8, 0, null, true, $9, $10, $11, $12::jsonb)
                RETURNING id;
              `, [
                examId,
                userId,
                JSON.stringify(answers),
                score,
                correctCount,
                wrongCount,
                unansweredCount,
                authoritativeTimeTaken,
                candidateName,
                candidateInstitution,
                exam.track || 'GEN',
                snapshotJson
              ]);
              submissionId = fallbackSaved.rows[0]?.id || null;
            } catch (fallbackErr) {
              req.log.error({ err: fallbackErr, examId }, 'Dynamic exam submission fallback persistence failed');
              await recordExamSessionFailure(db, examId, sessionId, 'persistence_failed').catch((telemetryError) => req.log.warn({ err: telemetryError, examId }, 'Unable to record failed submission'));
              return reply.status(503).send({ error: 'The submission could not be saved. Retry with the same idempotency key.', code: 'SUBMISSION_PERSISTENCE_FAILED' });
            }
          } else {
            req.log.error({ err, examId }, 'Dynamic exam submission persistence failed');
            await recordExamSessionFailure(db, examId, sessionId, 'persistence_failed').catch((telemetryError) => req.log.warn({ err: telemetryError, examId }, 'Unable to record failed submission'));
            return reply.status(503).send({ error: 'The submission could not be saved. Retry with the same idempotency key.', code: 'SUBMISSION_PERSISTENCE_FAILED' });
          }
        }
      }

      let rankInfo: { rank: number; totalCandidates: number } | null = null;
      if (submissionId && userId && !isPracticeMode) {
        try { await recordLearnerEvent(db, userId, 'exam_submitted'); }
        catch (err) { req.log.warn({ err, examId }, 'Optional exam analytics event was not recorded'); }
        const member = `user:${userId}`;
        await redis.submitExamScore(examId, member, candidateKey, score, authoritativeTimeTaken);
        rankInfo = await redis.getUserExamRank(examId, member);
        try {
          await db.query('UPDATE exam_submissions SET rank=$1 WHERE id=$2::uuid', [rankInfo.rank, submissionId]);
        } catch (err) {
          req.log.error({ err, examId, submissionId }, 'Dynamic exam submission rank persistence failed');
        }
      }
      const totalCandidates = rankInfo?.totalCandidates ?? ((await redis.getExamTotalParticipants(examId)) || 1);
      await recordExamSessionCompletion(db, examId, sessionId).catch((err) => req.log.warn({ err, examId }, 'Unable to record dynamic exam completion'));

      return {
        success: true,
        submissionId: submissionId || null,
        submissionPersisted: Boolean(submissionId),
        examId,
        score,
        totalMarks: exam.total_marks,
        correctCount,
        wrongCount,
        unansweredCount,
        timeTakenSeconds: authoritativeTimeTaken,
        rank: rankInfo?.rank ?? null,
        totalCandidates,
        percentile: rankInfo ? Math.max(1, Math.min(99, Math.round((1 - (rankInfo.rank / (rankInfo.totalCandidates || 1))) * 100))) : null,
        isPractice: isPracticeMode,
        feedback: reviewFeedback,
      };
    } catch (err: any) {
      await recordExamSessionFailure(db, examId, sessionId, 'request_failed').catch(() => undefined);
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 11. SUBMISSION SCRIPT REVIEW WITH PREDEFINED EXPLANATIONS & ANSWER KEYS
  // =========================================================================
  app.get('/api/v1/exam/submission/:id/review', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { examId?: string } }>, reply: FastifyReply) => {
    const { id: submissionId } = req.params;
    const examIdQuery = req.query.examId;
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(submissionId);
      let sub: any = null;
      let examIdToLoad: string | null = null;
      let answerMap: Record<string, { selectedOption: string | null; correctOption: string }> = {};
      let rawUserAnswers: Record<string, string> = {};

      if (isUuid) {
        // 1. Fetch submission details
        const subRes = await db.query(`
          SELECT es.id, es.exam_id AS "examId", es.user_id AS "userId", es.answers, es.score,
                 es.correct_count AS "correctCount", es.wrong_count AS "wrongCount",
                 es.unanswered_count AS "unansweredCount", es.time_taken_seconds AS "timeTakenSeconds",
                 es.rank, es.submitted_at AS "submittedAt", es.questions_snapshot AS "questionsSnapshot",
                 e.title AS "examTitle", e.total_marks AS "totalMarks",
                 COALESCE(e.negative_mark_per_question, 0.25) AS "negativeMark"
          FROM exam_submissions es
          JOIN exams e ON e.id = es.exam_id
          WHERE es.id = $1::uuid
          LIMIT 1;
        `, [submissionId]);

        if (subRes.rows.length > 0) {
          sub = subRes.rows[0];
          examIdToLoad = sub.examId;
          rawUserAnswers = (typeof sub.answers === 'object' && sub.answers !== null ? sub.answers : {}) as Record<string, string>;

          // 2. Fetch recorded answers from exam_submission_answers
          const ansRes = await db.query(`
            SELECT question_id AS "questionId", selected_option AS "selectedOption",
                   correct_option AS "correctOption", outcome
            FROM exam_submission_answers
            WHERE submission_id = $1::uuid;
          `, [submissionId]);

          for (const row of ansRes.rows) {
            answerMap[row.questionId] = {
              selectedOption: row.selectedOption,
              correctOption: row.correctOption,
            };
          }

          // Return immutable snapshot of attempt questions if persisted
          if (Array.isArray(sub.questionsSnapshot) && sub.questionsSnapshot.length > 0) {
            const snapQuestions = sub.questionsSnapshot.map((q: any, idx: number) => {
              const recordedAns = answerMap[q.id];
              const userChoice = recordedAns?.selectedOption ?? rawUserAnswers[q.id] ?? q.userAnswer ?? null;
              const correctKey = recordedAns?.correctOption ?? q.correctOptionId ?? q.correct_option_id ?? 'A';
              const explText = q.explanation || q.solution_markdown || '';
              return {
                id: q.id,
                order: q.order ?? idx + 1,
                subject: q.subject ?? q.subjectName ?? 'General',
                questionText: q.questionText ?? q.text ?? '',
                text: q.text ?? q.questionText ?? '',
                passage: q.passage ?? null,
                contextSnippet: q.contextSnippet ?? null,
                hasMath: Boolean(q.hasMath ?? q.has_math),
                options: (q.options || []).map((opt: any) => ({
                  id: opt.id ?? opt.key_original,
                  text: opt.text ?? '',
                  has_math: Boolean(opt.has_math ?? opt.hasMath),
                })),
                correctOptionId: correctKey,
                correct_option_id: correctKey,
                correctOption: correctKey,
                explanation: explText,
                solution_markdown: explText,
                userAnswer: userChoice,
              };
            });

            return {
              success: true,
              submission: sub,
              questions: snapQuestions,
            };
          }
        }
      }

      // If not a submission UUID or submission not found, attempt to treat as exam id/slug fallback
      if (!examIdToLoad) {
        const targetSlugOrId = (examIdQuery && examIdQuery.trim().length > 0) ? examIdQuery : submissionId;
        let examMatch;
        if (targetSlugOrId.startsWith('daily-')) {
          const uCode = targetSlugOrId.replace(/^daily-/, '').replace(/-live$/, '');
          examMatch = await db.query(`
            SELECT e.id, e.title, e.total_marks AS "totalMarks", COALESCE(e.negative_mark_per_question, 0.25) AS "negativeMark"
            FROM exams e 
            JOIN universities u ON u.id = e.target_university_id 
            WHERE LOWER(u.code) = LOWER($1) AND e.is_active = true 
            ORDER BY e.created_at DESC LIMIT 1
          `, [uCode]);
        } else {
          examMatch = await db.query(`
            SELECT id, title, total_marks AS "totalMarks", COALESCE(negative_mark_per_question, 0.25) AS "negativeMark"
            FROM exams
            WHERE id::text = $1 OR title ILIKE $1
            LIMIT 1;
          `, [targetSlugOrId]);
        }

        if (examMatch.rows.length > 0) {
          examIdToLoad = examMatch.rows[0].id;
          sub = {
            id: submissionId,
            examId: examIdToLoad,
            examTitle: examMatch.rows[0].title,
            totalMarks: examMatch.rows[0].totalMarks,
            negativeMark: examMatch.rows[0].negativeMark,
            score: 0,
            correctCount: 0,
            wrongCount: 0,
            unansweredCount: 0,
            timeTakenSeconds: 0,
          };
        } else {
          return reply.status(404).send({ error: 'Submission or exam not found' });
        }
      }

      // 3. Fetch all questions with verified answers and explanations
      const qRes = await db.query(`
        SELECT eq.question_order AS "order", q.id, q.stem_primary AS "questionText",
               (q.stem_primary LIKE '%$%' OR q.stem_primary LIKE '%\\%') AS "hasMath",
               q.options, q.solution_markdown AS "explanation",
               qs.content_text AS "passage",
               q.context_snippet AS "contextSnippet",
               s.name AS "subjectName"
        FROM exam_questions eq
        JOIN questions q ON q.id = eq.question_id
        LEFT JOIN academic_subjects s ON s.id = q.subject_id
        LEFT JOIN question_stimuli qs ON qs.id = q.stimulus_id
        WHERE eq.exam_id = $1::uuid
        ORDER BY eq.question_order ASC;
      `, [examIdToLoad]);

      const questions = qRes.rows.map((row) => {
        const rawOpts = Array.isArray(row.options) ? row.options : [];
        let detectedCorrect = 'A';
        const formattedOptions = rawOpts.map((opt: any, idx: number) => {
          const letter = opt.key_original || String.fromCharCode(65 + idx);
          if (opt.is_correct === true || opt.is_correct === 'true') {
            detectedCorrect = letter;
          }
          return {
            id: letter,
            text: opt.text || '',
            has_math: Boolean(opt.has_math || opt.hasMath),
          };
        });

        const recordedAns = answerMap[row.id];
        const correctLetter = recordedAns?.correctOption || detectedCorrect;
        const userChoice = recordedAns?.selectedOption ?? rawUserAnswers[row.id] ?? null;

        return {
          id: row.id,
          order: row.order,
          subject: row.subjectName || 'General',
          questionText: row.questionText,
          text: row.questionText,
          passage: row.passage || null,
          contextSnippet: row.contextSnippet || null,
          hasMath: row.hasMath,
          options: formattedOptions,
          correctOptionId: correctLetter,
          correct_option_id: correctLetter,
          correctOption: correctLetter,
          explanation: row.explanation || '',
          solution_markdown: row.explanation || '',
          userAnswer: userChoice,
        };
      });

      return {
        success: true,
        submission: sub,
        questions,
      };
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 12. USER-SPECIFIC MISTAKE & SKIPPED VAULT WITH TOPIC DEFICIT RANKING
  // =========================================================================
  app.get('/api/v1/user/vault/summary', async (req: FastifyRequest<{ Querystring: { userId?: string } }>, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    const identity = await resolveCandidateIdentity(req);
    const userId = identity.userId || req.query.userId || (req.headers['x-user-id'] as string) || null;
    if (!userId) {
      return reply.status(401).send({ error: 'Sign in to access your personal mistake and skipped question vault.' });
    }

    try {
      // 1. Weakest Topics Ranking (by mistakes & skips deficit)
      const topicRes = await db.query(`
        SELECT
          t.id AS "topicId",
          t.name AS "topicName",
          s.id AS "subjectId",
          s.name AS "subjectName",
          COUNT(CASE WHEN esa.outcome = 'wrong' THEN 1 END)::int AS "wrongCount",
          COUNT(CASE WHEN esa.outcome = 'skipped' THEN 1 END)::int AS "skippedCount",
          (COUNT(CASE WHEN esa.outcome = 'wrong' THEN 1 END) * 2 + COUNT(CASE WHEN esa.outcome = 'skipped' THEN 1 END))::int AS "deficitScore",
          COUNT(*)::int AS "totalAttempts"
        FROM exam_submission_answers esa
        JOIN exam_submissions es ON es.id = esa.submission_id
        JOIN academic_topics t ON t.id = esa.topic_id
        LEFT JOIN academic_subjects s ON s.id = esa.subject_id
        WHERE es.user_id = $1::uuid
          AND esa.outcome IN ('wrong', 'skipped')
        GROUP BY t.id, t.name, s.id, s.name
        ORDER BY "deficitScore" DESC, "wrongCount" DESC
        LIMIT 10;
      `, [userId]);

      const weakTopics = topicRes.rows.map((row, idx) => ({
        rank: idx + 1,
        topicId: row.topicId,
        topicName: row.topicName,
        subjectId: row.subjectId,
        subjectName: row.subjectName || 'General',
        wrongCount: row.wrongCount,
        skippedCount: row.skippedCount,
        deficitScore: row.deficitScore,
        totalAttempts: row.totalAttempts,
        recommendation: `High-impact deficit in ${row.topicName}. Recommended to take an adaptive 15-question optimization test.`,
      }));

      // 2. Active Mistakes from mistake_vault
      const mistakeRes = await db.query(`
        SELECT q.id, q.stem_primary AS "questionText",
               (q.stem_primary LIKE '%$%' OR q.stem_primary LIKE '%\\%') AS "hasMath",
               q.options, q.solution_markdown AS "explanation",
               qs.content_text AS "passage",
               q.context_snippet AS "contextSnippet",
               s.name AS "subjectName",
               t.name AS "topicName",
               mv.wrong_count AS "wrongCount",
               mv.next_review_at AS "nextReviewAt"
        FROM mistake_vault mv
        JOIN questions q ON q.id = mv.question_id
        LEFT JOIN academic_subjects s ON s.id = q.subject_id
        LEFT JOIN academic_topics t ON t.id = q.topic_id
        LEFT JOIN question_stimuli qs ON qs.id = q.stimulus_id
        WHERE mv.user_id = $1::uuid AND mv.is_mastered = false
        ORDER BY mv.wrong_count DESC, mv.next_review_at ASC
        LIMIT 50;
      `, [userId]);

      const formatQuestion = (row: any) => {
        const rawOpts = Array.isArray(row.options) ? row.options : [];
        let detectedCorrect = 'A';
        const formattedOpts = rawOpts.map((opt: any, i: number) => {
          const letter = opt.key_original || String.fromCharCode(65 + i);
          if (opt.is_correct === true || opt.is_correct === 'true') {
            detectedCorrect = letter;
          }
          return {
            id: letter,
            text: opt.text || '',
            has_math: Boolean(opt.has_math || opt.hasMath),
          };
        });
        return {
          id: row.id,
          subject: row.subjectName || 'General',
          topic: row.topicName || '',
          questionText: row.questionText,
          passage: row.passage || null,
          contextSnippet: row.contextSnippet || null,
          hasMath: row.hasMath,
          options: formattedOpts,
          correctOptionId: detectedCorrect,
          explanation: row.explanation || '',
          wrongCount: row.wrongCount || 1,
        };
      };

      const mistakes = mistakeRes.rows.map(formatQuestion);

      // 3. Distinct Skipped Questions
      const skippedRes = await db.query(`
        SELECT DISTINCT ON (q.id)
               q.id, q.stem_primary AS "questionText",
               (q.stem_primary LIKE '%$%' OR q.stem_primary LIKE '%\\%') AS "hasMath",
               q.options, q.solution_markdown AS "explanation",
               qs.content_text AS "passage",
               q.context_snippet AS "contextSnippet",
               s.name AS "subjectName",
               t.name AS "topicName",
               esa.created_at AS "skippedAt"
        FROM exam_submission_answers esa
        JOIN exam_submissions es ON es.id = esa.submission_id
        JOIN questions q ON q.id = esa.question_id
        LEFT JOIN academic_subjects s ON s.id = q.subject_id
        LEFT JOIN academic_topics t ON t.id = q.topic_id
        LEFT JOIN question_stimuli qs ON qs.id = q.stimulus_id
        WHERE es.user_id = $1::uuid AND esa.outcome = 'skipped'
        ORDER BY q.id, esa.created_at DESC
        LIMIT 50;
      `, [userId]);

      const skipped = skippedRes.rows.map(formatQuestion);

      return {
        success: true,
        userId,
        totalMistakes: mistakes.length,
        totalSkipped: skipped.length,
        weakTopics,
        mistakes,
        skipped,
      };
    } catch (err: any) {
      req.log.error({ err, userId }, 'Error generating vault summary');
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 13. ADAPTIVE LIVE DB TOPIC RE-TEST / OPTIMIZE
  // =========================================================================
  app.get('/api/v1/user/vault/topic-practice/:topicId', async (req: FastifyRequest<{ Params: { topicId: string }; Querystring: { limit?: string } }>, reply: FastifyReply) => {
    const { topicId } = req.params;
    const limit = Math.min(50, Math.max(5, parseInt(req.query.limit || '15', 10)));
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    try {
      const topicInfo = await db.query(`
        SELECT t.id, t.name, s.name AS "subjectName", s.slug AS "subjectSlug"
        FROM academic_topics t
        LEFT JOIN academic_subjects s ON s.id = t.subject_id
        WHERE t.id = $1::uuid
        LIMIT 1;
      `, [topicId]);

      if (topicInfo.rows.length === 0) {
        return reply.status(404).send({ error: 'Topic not found' });
      }

      const topic = topicInfo.rows[0];

      // Fetch live verified questions from Postgres for this topic
      const qRes = await db.query(`
        SELECT q.id, q.stem_primary AS "questionText",
               (q.stem_primary LIKE '%$%' OR q.stem_primary LIKE '%\\%') AS "hasMath",
               q.options, q.solution_markdown AS "explanation",
               qs.content_text AS "passage",
               q.context_snippet AS "contextSnippet",
               q.difficulty_rating AS "difficultyRating"
        FROM questions q
        LEFT JOIN question_stimuli qs ON qs.id = q.stimulus_id
        WHERE q.topic_id = $1::uuid
          AND q.is_active = true
          AND q.review_status = 'approved'
        ORDER BY RANDOM()
        LIMIT $2;
      `, [topicId, limit]);

      const questions = qRes.rows.map((row, idx) => {
        const rawOpts = Array.isArray(row.options) ? row.options : [];
        let detectedCorrect = 'A';
        const formattedOpts = rawOpts.map((opt: any, i: number) => {
          const letter = opt.key_original || String.fromCharCode(65 + i);
          if (opt.is_correct === true || opt.is_correct === 'true') {
            detectedCorrect = letter;
          }
          return {
            id: letter,
            text: opt.text || '',
            has_math: Boolean(opt.has_math || opt.hasMath),
          };
        });

        return {
          id: row.id,
          order: idx + 1,
          subject: topic.subjectName || 'General',
          questionText: row.questionText,
          passage: row.passage || null,
          contextSnippet: row.contextSnippet || null,
          hasMath: row.hasMath,
          options: formattedOpts,
          correctOptionId: detectedCorrect,
          explanation: row.explanation || '',
        };
      });

      return {
        success: true,
        topicId: topic.id,
        topicName: topic.name,
        subjectName: topic.subjectName,
        totalQuestions: questions.length,
        questions,
      };
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });
};
