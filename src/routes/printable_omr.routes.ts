import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import crypto from 'crypto';
import { z } from 'zod';
import { resolveCandidateIdentity } from '../services/learner_identity.service';
import { sendInternalError } from '../services/http_errors';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function generateShortCode(): string {
  const bytes = crypto.randomBytes(6);
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `P404-${suffix}`;
}

function normalizePackCode(raw: string): string {
  const trimmed = raw.trim();
  const uriMatch = trimmed.match(/prep404:\/\/omr\/([A-Za-z0-9-]+)/i);
  if (uriMatch) return uriMatch[1].toUpperCase();
  const urlMatch = trimmed.match(/\/omr\/([A-Za-z0-9-]+)/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  return trimmed.toUpperCase();
}

const generatePackSchema = z.object({
  examId: z.string().uuid(),
  setLabel: z.string().trim().min(1).max(16).optional(),
  shuffleOptions: z.boolean().optional(),
});

const submitAttemptSchema = z.object({
  answers: z.record(z.string(), z.string().trim().min(1).max(4)),
  timeSpentMinutes: z.number().int().min(0).max(600).optional(),
  notes: z.string().trim().max(500).optional(),
});

async function ensureUserRowExists(db: Pool, userId: string): Promise<void> {
  const existing = await db.query('SELECT id FROM public.users WHERE id = $1::uuid LIMIT 1', [userId]);
  if (existing.rows.length > 0) return;

  await db.query(
    `INSERT INTO public.users (id, full_name, email, is_onboarded, created_at, updated_at)
     SELECT au.id,
            COALESCE(NULLIF(au.raw_user_meta_data->>'full_name', ''), NULLIF(au.raw_user_meta_data->>'name', ''), split_part(COALESCE(au.email, 'Student'), '@', 1)),
            au.email,
            true,
            COALESCE(au.created_at, now()),
            now()
     FROM auth.users au
     WHERE au.id = $1::uuid
     ON CONFLICT (id) DO NOTHING`,
    [userId],
  );
}

export const printableOmrRoutes: FastifyPluginAsync<{ db: Pool }> = async (
  app: FastifyInstance,
  opts: { db: Pool },
) => {
  const { db } = opts;

  // =========================================================================
  // 1. GENERATE A PRINTABLE OMR + QUESTION PACK WITH UNIQUE QR CODE
  // =========================================================================
  app.post('/api/v1/omr-packs/generate', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });

    const parsed = generatePackSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten() });
    }

    const { examId, setLabel = 'SET-A', shuffleOptions = false } = parsed.data;

    try {
      const examRes = await db.query(
        `SELECT e.id, e.title, ROUND(e.duration_seconds / 60.0)::int AS "durationMinutes",
                COALESCE(e.negative_mark_per_question, 0)::numeric AS "negativeMark",
                u.code AS "universityCode", u.full_name AS "universityName"
         FROM public.exams e
         LEFT JOIN public.universities u ON u.id = e.target_university_id
         WHERE e.id = $1::uuid AND e.is_active = true
         LIMIT 1`,
        [examId],
      );

      if (examRes.rows.length === 0) {
        return reply.status(404).send({ error: 'Exam not found or inactive.' });
      }
      const exam = examRes.rows[0];

      const qRes = await db.query(
        `SELECT eq.question_order AS "order", q.id AS "questionId",
                q.stem_primary AS "questionText",
                q.options,
                q.solution_markdown AS "solutionMarkdown",
                s.name AS "subjectName",
                qs.content_text AS "passage",
                q.context_snippet AS "contextSnippet"
         FROM public.exam_questions eq
         JOIN public.questions q ON q.id = eq.question_id
         LEFT JOIN public.academic_subjects s ON s.id = q.subject_id
         LEFT JOIN public.question_stimuli qs ON qs.id = q.stimulus_id
         WHERE eq.exam_id = $1::uuid AND q.is_active = true
         ORDER BY eq.question_order ASC`,
        [examId],
      );

      const relationalOptionPattern = /\b(all|none)\s+of\s+the\s+(above|below|mentioned)|above\s+all|none\s+of\s+these|all\s+of\s+these|\bboth\s+(\([a-d]\)|[a-d])\s+and\s+(\([a-d]\)|[a-d])\b/i;

      const questionSnapshot: Array<{
        order: number;
        questionId: string;
        subjectName: string;
        questionText: string;
        passage: string | null;
        options: Array<{ id: string; text: string }>;
        correctOption: string;
        solutionMarkdown: string;
      }> = [];
      const answerKey: Record<string, string> = {};

      let seq = 0;
      for (const row of qRes.rows) {
        const rawOpts = Array.isArray(row.options) ? [...row.options] : [];
        if (rawOpts.length < 2) continue;

        const hasRelational = rawOpts.some((opt: any) => relationalOptionPattern.test(String(opt?.text || '')));
        if (shuffleOptions && !hasRelational) {
          for (let i = rawOpts.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rawOpts[i], rawOpts[j]] = [rawOpts[j], rawOpts[i]];
          }
        }

        seq += 1;
        let correctLetter = 'A';
        const formattedOptions = rawOpts.slice(0, 4).map((opt: any, idx: number) => {
          const letter = String.fromCharCode(65 + idx);
          if (opt?.is_correct === true || opt?.is_correct === 'true') {
            correctLetter = letter;
          }
          return { id: letter, text: String(opt?.text || '').trim() };
        });

        answerKey[String(seq)] = correctLetter;
        questionSnapshot.push({
          order: seq,
          questionId: String(row.questionId),
          subjectName: String(row.subjectName || 'General'),
          questionText: String(row.questionText || '').trim(),
          passage: row.passage || row.contextSnippet || null,
          options: formattedOptions,
          correctOption: correctLetter,
          solutionMarkdown: String(row.solutionMarkdown || '').trim(),
        });
      }

      if (questionSnapshot.length === 0) {
        return reply.status(409).send({ error: 'This exam has no printable MCQ questions yet.' });
      }

      if (identity.userId) {
        await ensureUserRowExists(db, identity.userId);
      }

      let shortCode = generateShortCode();
      let insertedRow: any = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const ins = await db.query(
            `INSERT INTO public.printable_omr_sets (
               short_code, exam_id, user_id, title, university_code,
               set_label, duration_minutes, negative_mark, total_questions,
               question_snapshot, answer_key
             )
             VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
             RETURNING id, short_code, title, university_code, set_label,
                       duration_minutes, negative_mark, total_questions, created_at`,
            [
              shortCode,
              exam.id,
              identity.userId,
              exam.title,
              exam.universityCode || null,
              setLabel,
              Number(exam.durationMinutes) || 30,
              Number(exam.negativeMark) || 0,
              questionSnapshot.length,
              JSON.stringify(questionSnapshot),
              JSON.stringify(answerKey),
            ],
          );
          insertedRow = ins.rows[0];
          break;
        } catch (err: any) {
          if (err?.code === '23505') {
            shortCode = generateShortCode();
            continue;
          }
          throw err;
        }
      }

      if (!insertedRow) {
        return reply.status(500).send({ error: 'Failed to allocate unique OMR set code.' });
      }

      return reply.status(201).send({
        success: true,
        pack: {
          id: insertedRow.id,
          shortCode: insertedRow.short_code,
          qrPayload: `prep404://omr/${insertedRow.short_code}`,
          examId: exam.id,
          title: insertedRow.title,
          universityCode: insertedRow.university_code,
          universityName: exam.universityName || insertedRow.university_code,
          setLabel: insertedRow.set_label,
          durationMinutes: Number(insertedRow.duration_minutes),
          negativeMark: Number(insertedRow.negative_mark),
          totalQuestions: Number(insertedRow.total_questions),
          createdAt: insertedRow.created_at,
          // Return questions without leaking answer key on the paper PDF payload
          questions: questionSnapshot.map((q) => ({
            order: q.order,
            questionId: q.questionId,
            subjectName: q.subjectName,
            questionText: q.questionText,
            passage: q.passage,
            options: q.options,
          })),
        },
      });
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 2. AUTHENTICATED LEARNER'S PRINTABLE OMR HISTORY (GENERATED + ATTEMPTS)
  // =========================================================================
  app.get('/api/v1/omr-packs/my-history', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });
    if (!identity.userId) return reply.status(401).send({ error: 'Sign in to view your offline OMR practice history.' });

    try {
      const [setsRes, attemptsRes] = await Promise.all([
        db.query(
          `SELECT s.id, s.short_code AS "shortCode", s.exam_id AS "examId",
                  s.title, s.university_code AS "universityCode",
                  s.set_label AS "setLabel", s.duration_minutes AS "durationMinutes",
                  s.negative_mark::float AS "negativeMark",
                  s.total_questions AS "totalQuestions",
                  s.scan_count AS "scanCount",
                  s.created_at AS "createdAt",
                  (SELECT COUNT(*)::int FROM public.printable_omr_attempts a
                    WHERE a.omr_set_id = s.id AND a.user_id = $1::uuid) AS "attemptCount",
                  (SELECT MAX(a.score)::float FROM public.printable_omr_attempts a
                    WHERE a.omr_set_id = s.id AND a.user_id = $1::uuid) AS "bestScore"
           FROM public.printable_omr_sets s
           WHERE s.user_id = $1::uuid
              OR EXISTS (
                SELECT 1 FROM public.printable_omr_attempts a
                WHERE a.omr_set_id = s.id AND a.user_id = $1::uuid
              )
           ORDER BY s.created_at DESC
           LIMIT 50`,
          [identity.userId],
        ),
        db.query(
          `SELECT a.id, a.omr_set_id AS "omrSetId", s.short_code AS "shortCode",
                  s.title, s.university_code AS "universityCode",
                  a.correct_count AS "correctCount", a.wrong_count AS "wrongCount",
                  a.skipped_count AS "skippedCount", a.score::float AS "score",
                  a.total_questions AS "totalQuestions",
                  a.accuracy_percent::float AS "accuracyPercent",
                  a.time_spent_minutes AS "timeSpentMinutes",
                  a.created_at AS "createdAt"
           FROM public.printable_omr_attempts a
           JOIN public.printable_omr_sets s ON s.id = a.omr_set_id
           WHERE a.user_id = $1::uuid
           ORDER BY a.created_at DESC
           LIMIT 50`,
          [identity.userId],
        ),
      ]);

      return reply.send({
        success: true,
        packs: setsRes.rows,
        attempts: attemptsRes.rows,
      });
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 3. RESOLVE A SCANNED QR CODE / SET CODE → IMMEDIATE SET + ANSWER KEY
  // =========================================================================
  app.get('/api/v1/omr-packs/:code', async (req: FastifyRequest<{ Params: { code: string } }>, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });

    const rawCode = req.params.code || '';
    const isUuid = UUID_PATTERN.test(rawCode.trim());
    const normalizedCode = normalizePackCode(rawCode);

    try {
      const setRes = await db.query(
        isUuid
          ? `UPDATE public.printable_omr_sets
             SET scan_count = scan_count + 1
             WHERE id = $1::uuid
             RETURNING id, short_code, exam_id, title, university_code, set_label,
                       duration_minutes, negative_mark::float AS negative_mark,
                       total_questions, question_snapshot, answer_key, scan_count, created_at`
          : `UPDATE public.printable_omr_sets
             SET scan_count = scan_count + 1
             WHERE UPPER(short_code) = $1
             RETURNING id, short_code, exam_id, title, university_code, set_label,
                       duration_minutes, negative_mark::float AS negative_mark,
                       total_questions, question_snapshot, answer_key, scan_count, created_at`,
        [isUuid ? rawCode.trim() : normalizedCode],
      );

      if (setRes.rows.length === 0) {
        return reply.status(404).send({
          error: `No printable practice set found for code "${normalizedCode}". Check the code printed under the QR and try again.`,
        });
      }

      const row = setRes.rows[0];
      let previousAttempts: any[] = [];
      if (identity.userId) {
        const attRes = await db.query(
          `SELECT id, answers, correct_count AS "correctCount", wrong_count AS "wrongCount",
                  skipped_count AS "skippedCount", score::float AS "score",
                  total_questions AS "totalQuestions",
                  accuracy_percent::float AS "accuracyPercent",
                  time_spent_minutes AS "timeSpentMinutes",
                  notes, created_at AS "createdAt"
           FROM public.printable_omr_attempts
           WHERE omr_set_id = $1::uuid AND user_id = $2::uuid
           ORDER BY created_at DESC
           LIMIT 20`,
          [row.id, identity.userId],
        );
        previousAttempts = attRes.rows;
      }

      return reply.send({
        success: true,
        pack: {
          id: row.id,
          shortCode: row.short_code,
          qrPayload: `prep404://omr/${row.short_code}`,
          examId: row.exam_id,
          title: row.title,
          universityCode: row.university_code,
          setLabel: row.set_label,
          durationMinutes: Number(row.duration_minutes),
          negativeMark: Number(row.negative_mark),
          totalQuestions: Number(row.total_questions),
          scanCount: Number(row.scan_count),
          createdAt: row.created_at,
          answerKey: row.answer_key || {},
          questions: Array.isArray(row.question_snapshot) ? row.question_snapshot : [],
        },
        previousAttempts,
      });
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 4. RECORD OFFLINE PAPER PRACTICE ATTEMPT & SERVER-AUTHORITATIVE SCORING
  // =========================================================================
  app.post('/api/v1/omr-packs/:code/attempts', async (req: FastifyRequest<{ Params: { code: string } }>, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });
    if (!identity.userId) return reply.status(401).send({ error: 'Sign in to save your offline practice record.' });

    const parsed = submitAttemptSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid attempt payload', details: parsed.error.flatten() });
    }

    const rawCode = req.params.code || '';
    const isUuid = UUID_PATTERN.test(rawCode.trim());
    const normalizedCode = normalizePackCode(rawCode);

    try {
      const setRes = await db.query(
        isUuid
          ? `SELECT id, short_code, total_questions, negative_mark::float AS negative_mark, answer_key
             FROM public.printable_omr_sets WHERE id = $1::uuid LIMIT 1`
          : `SELECT id, short_code, total_questions, negative_mark::float AS negative_mark, answer_key
             FROM public.printable_omr_sets WHERE UPPER(short_code) = $1 LIMIT 1`,
        [isUuid ? rawCode.trim() : normalizedCode],
      );

      if (setRes.rows.length === 0) {
        return reply.status(404).send({ error: 'Printable practice set not found.' });
      }

      const pack = setRes.rows[0];
      const answerKey: Record<string, string> = pack.answer_key || {};
      const totalQuestions = Number(pack.total_questions) || Object.keys(answerKey).length;
      const negativeMark = Number(pack.negative_mark) || 0;

      const normalizedAnswers: Record<string, string> = {};
      let correctCount = 0;
      let wrongCount = 0;

      for (const [qNum, expectedLetter] of Object.entries(answerKey)) {
        const chosenRaw = parsed.data.answers[qNum];
        if (!chosenRaw) continue;
        const chosen = chosenRaw.trim().toUpperCase();
        normalizedAnswers[qNum] = chosen;
        if (chosen === String(expectedLetter).trim().toUpperCase()) {
          correctCount += 1;
        } else {
          wrongCount += 1;
        }
      }

      const skippedCount = Math.max(0, totalQuestions - correctCount - wrongCount);
      const rawScore = correctCount - wrongCount * negativeMark;
      const score = Number(rawScore.toFixed(2));
      const answeredTotal = correctCount + wrongCount;
      const accuracyPercent = answeredTotal === 0
        ? 0
        : Number(((correctCount / answeredTotal) * 100).toFixed(2));

      await ensureUserRowExists(db, identity.userId);

      const ins = await db.query(
        `INSERT INTO public.printable_omr_attempts (
           omr_set_id, user_id, answers, correct_count, wrong_count, skipped_count,
           score, total_questions, accuracy_percent, time_spent_minutes, notes
         )
         VALUES ($1::uuid, $2::uuid, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, created_at AS "createdAt"`,
        [
          pack.id,
          identity.userId,
          JSON.stringify(normalizedAnswers),
          correctCount,
          wrongCount,
          skippedCount,
          score,
          totalQuestions,
          accuracyPercent,
          parsed.data.timeSpentMinutes ?? null,
          parsed.data.notes ?? null,
        ],
      );

      return reply.status(201).send({
        success: true,
        attempt: {
          id: ins.rows[0].id,
          shortCode: pack.short_code,
          correctCount,
          wrongCount,
          skippedCount,
          score,
          totalQuestions,
          accuracyPercent,
          negativeMark,
          answers: normalizedAnswers,
          timeSpentMinutes: parsed.data.timeSpentMinutes ?? null,
          createdAt: ins.rows[0].createdAt,
        },
      });
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });
};
