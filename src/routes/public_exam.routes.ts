import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { RedisService } from '../redis/redis.service';
import { ExamScoringService } from '../services/exam_scoring.service';
import { requireStaffRole } from '../middleware/rbac.middleware';
import { randomUUID } from 'crypto';
import { registerExamSubmissionIdempotency } from '../services/exam_idempotency.service';
import { hashExamSessionId, recordExamSessionCompletion, recordExamSessionFailure, recordExamSessionStart } from '../services/exam_session_telemetry.service';
import { sendInternalError } from '../services/http_errors';

export const sanitizeExamQuestion = (q: unknown): Record<string, unknown> => {
  if (!q || typeof q !== 'object') return {};
  const qObj = q as Record<string, unknown>;
  const rawOpts = Array.isArray(qObj.options) ? qObj.options : [];
  const options = rawOpts.map((opt: unknown, idx: number) => {
    if (opt && typeof opt === 'object') {
      const o = opt as Record<string, unknown>;
      return {
        id: (o.id || o.key_original || String.fromCharCode(65 + idx)) as string,
        text: (typeof o.text === 'string' ? o.text : '') as string,
      };
    }
    return {
      id: String.fromCharCode(65 + idx),
      text: typeof opt === 'string' ? opt : '',
    };
  });

  return {
    id: qObj.id,
    order: qObj.order ?? qObj.question_order,
    questionText: qObj.questionText ?? qObj.stem_primary ?? '',
    passage: qObj.passage ?? (qObj.stimulus && typeof qObj.stimulus === 'object' ? (qObj.stimulus as any).content_text : null) ?? null,
    contextSnippet: qObj.contextSnippet ?? qObj.context_snippet ?? null,
    hasMath: Boolean(qObj.hasMath ?? qObj.has_math),
    options,
    ...(qObj.difficultyRating !== undefined || qObj.difficulty_rating !== undefined
      ? { difficultyRating: parseFloat(String(qObj.difficultyRating ?? qObj.difficulty_rating ?? '1.0')) }
      : {}),
  };
};

export const sanitizeExamSnapshot = (value: unknown): unknown => {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(sanitizeExamQuestion);
  }
  const valObj = value as Record<string, unknown>;
  const rawQuestions = Array.isArray(valObj.questions) ? valObj.questions : [];
  const questions = rawQuestions.map(sanitizeExamQuestion);

  return {
    examId: valObj.examId || valObj.id,
    slug: valObj.slug,
    accessKey: valObj.accessKey,
    title: valObj.title,
    examType: valObj.examType || valObj.exam_type,
    track: valObj.track,
    durationMinutes: valObj.durationMinutes || valObj.duration_minutes,
    totalMarks: valObj.totalMarks ?? valObj.total_marks,
    negativeMark: valObj.negativeMark ?? valObj.negative_mark,
    questionCount: questions.length,
    questions,
    ...(valObj.startsAt || valObj.starts_at ? { startsAt: valObj.startsAt || valObj.starts_at } : {}),
    ...(valObj.endsAt || valObj.ends_at ? { endsAt: valObj.endsAt || valObj.ends_at } : {}),
  };
};

export const publicExamRoutes: FastifyPluginAsync<{ db: Pool; redis: RedisService }> = async (
  app: FastifyInstance,
  opts: { db: Pool; redis: RedisService }
) => {
  const { db, redis } = opts;
  // Public candidates are anonymous: the key is scoped to their exam session.
  registerExamSubmissionIdempotency(app, redis, async () => null);

  app.post('/api/v1/public/exam/:slug/start', async (req: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
    try {
      const { slug } = req.params;
      const result = slug.includes('-') && slug.length >= 32
        ? await db.query(`SELECT id FROM public.exams WHERE id=$1::uuid AND is_active=true AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())`, [slug])
        : await db.query(`SELECT id FROM public.exams WHERE is_active=true AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now()) ORDER BY created_at DESC LIMIT 1`);
      if (!result.rowCount) return reply.status(404).send({ error: 'Model test not found' });
      const sessionId = randomUUID();
      try { await recordExamSessionStart(db, result.rows[0].id, sessionId, 'public'); }
      catch (err) {
        req.log.error({ err, examId: result.rows[0].id }, 'Unable to record public exam session start');
        return reply.status(503).send({ error: 'Unable to initialize an exam session. Please try again.' });
      }
      return { success: true, sessionId };
    } catch (err: any) { return reply.status(500).send({ error: 'Unable to start exam session' }); }
  });

  // =========================================================================
  // 1. PUBLIC LINK RESOLUTION FOR CANDIDATE EXAM PORTAL
  // =========================================================================
  app.get('/api/v1/public/exam/:slug', async (req: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
    const { slug } = req.params;
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    try {
      let examRes;
      if (slug.includes('-') && slug.length >= 32) {
        examRes = await db.query(`SELECT * FROM exams WHERE id = $1::uuid AND is_active = true
          AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())`, [slug]);
      } else {
        examRes = await db.query(`SELECT * FROM exams WHERE is_active = true
          AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
          ORDER BY created_at DESC LIMIT 1`);
      }

      if (examRes.rows.length === 0) {
        return reply.status(404).send({ error: 'Model test not found' });
      }

      const exam = examRes.rows[0];

      // Fetch questions without leaking answers/solutions
      const qRes = await db.query(`
        SELECT 
          eq.question_order,
          q.id,
          q.stem_primary AS "questionText",
          (q.stem_primary LIKE '%$%' OR q.stem_primary LIKE '%\\%') AS "hasMath",
          q.options
        FROM exam_questions eq
        JOIN questions q ON q.id = eq.question_id
        WHERE eq.exam_id = $1::uuid
        ORDER BY eq.question_order ASC;
      `, [exam.id]);

      const sanitizedQuestions = qRes.rows.map((row) => {
        const rawOpts = Array.isArray(row.options) ? row.options : [];
        const opts = rawOpts.map((opt: any, idx: number) => ({
          id: opt.key_original || String.fromCharCode(65 + idx),
          text: opt.text || '',
        }));
        return {
          id: row.id,
          questionText: row.questionText,
          hasMath: row.hasMath,
          options: opts,
        };
      });

      return {
        success: true,
        exam: {
          id: exam.id,
          slug: exam.id,
          title: exam.title,
          track: exam.track,
          durationMinutes: Math.round(exam.duration_seconds / 60),
          totalMarks: exam.total_marks,
          negativeMark: exam.negative_mark_per_question ?? 0.25,
          questionCount: sanitizedQuestions.length,
          shareableUrl: `https://prep404.com/m/${exam.id}`,
          startsAt: exam.starts_at,
          questions: sanitizedQuestions,
        },
      };
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 2. PUBLIC EXAM SUBMISSION & INSTANT MERIT RANKING
  // =========================================================================
  app.post('/api/v1/public/exam/:slug/submit', async (req: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
    const { slug } = req.params;
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
    const submittedSessionId = typeof (req.body as any)?.sessionId === 'string' ? (req.body as any).sessionId : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(submittedSessionId)) {
      return reply.status(400).send({ error: 'Start this exam before submitting your answers.' });
    }
    let sessionExamId: string | null = null;

    try {
      let examRes;
      if (slug.includes('-') && slug.length >= 32) {
        examRes = await db.query(`SELECT * FROM exams WHERE id = $1::uuid AND is_active = true
          AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())`, [slug]);
      } else {
        examRes = await db.query(`SELECT * FROM exams WHERE is_active = true
          AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
          ORDER BY created_at DESC LIMIT 1`);
      }

      if (examRes.rows.length === 0) {
        return reply.status(404).send({ error: 'Model test not found' });
      }
      const exam = examRes.rows[0];
      sessionExamId = exam.id;

      const body = req.body as any;
      const candidateName = body.candidateName || 'Anonymous Candidate';
      const candidateInstitution = body.candidateInstitution || 'College';
      const answers = body.answers || {};
      const sessionId = submittedSessionId;

      // A ranked public submission must reference a persisted server-created session.
      const sessionRes = await db.query(
        `SELECT GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - started_at)))::int) AS elapsed_seconds,
                submitted_at FROM public.exam_session_telemetry
          WHERE session_hash = $1 AND exam_id = $2::uuid LIMIT 1`,
        [hashExamSessionId(sessionId), exam.id]
      );
      if (!sessionRes.rowCount) return reply.status(403).send({ error: 'This exam session is invalid or expired. Start the exam again.' });
      if (sessionRes.rows[0].submitted_at) return reply.status(409).send({ error: 'This exam session has already been submitted.' });
      const authoritativeTimeTaken = Number(sessionRes.rows[0].elapsed_seconds);

      // Fetch questions with solutions for server-side evaluation
      const qRes = await db.query(`
        SELECT q.id, q.stem_primary, q.options, q.solution_markdown
        FROM exam_questions eq
        JOIN questions q ON q.id = eq.question_id
        WHERE eq.exam_id = $1::uuid
        ORDER BY eq.question_order ASC;
      `, [exam.id]);

      const evaluation = ExamScoringService.evaluateSubmission({
        questions: qRes.rows,
        answers,
        totalMarks: exam.total_marks,
        negativeMarkPerQuestion: exam.negative_mark_per_question ?? 0.25,
        timeTakenSeconds: authoritativeTimeTaken,
      });

      // Anti-Cheat: Reject bot submissions with unnatural completion speed
      if (evaluation.isSuspiciousSpeed) {
        if (sessionId) await recordExamSessionFailure(db, exam.id, sessionId, 'suspicious_speed').catch((err) => req.log.warn({ err, examId: exam.id }, 'Unable to record rejected public submission'));
        return reply.status(400).send({ 
          error: 'Submission rejected: completion time is unnaturally low. Automated script detected.',
          code: 'SUSPICIOUS_SPEED' 
        });
      }

      if (typeof redis.recordQuestionTelemetryBatch === 'function') {
        await redis.recordQuestionTelemetryBatch(exam.id, evaluation.feedback);
      } else if (typeof redis.recordQuestionTelemetry === 'function') {
        for (const item of evaluation.feedback) {
          if (item.selectedOption) {
            await redis.recordQuestionTelemetry(exam.id, item.questionId, item.selectedOption);
          }
        }
      }

      const { score, correctCount, wrongCount, unansweredCount, feedback } = evaluation;
      const candidateId = `user_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const displayName = `${candidateName} (${candidateInstitution})`;
      // Anonymous web candidates are keyed by their server-issued session, never by name.
      const member = `guest:${sessionId}`;

      const maxAllowedSeconds = (exam.duration_seconds || 1800) + 120;
      if (authoritativeTimeTaken <= maxAllowedSeconds) {
        await redis.submitExamScore(exam.id, member, displayName, score, authoritativeTimeTaken);
      }
      const rankInfo = await redis.getUserExamRank(exam.id, member);
      if (sessionId) await recordExamSessionCompletion(db, exam.id, sessionId).catch((err) => req.log.warn({ err, examId: exam.id }, 'Unable to record public exam completion'));

      return {
        success: true,
        candidateName,
        candidateId,
        score,
        totalMarks: exam.total_marks,
        correctCount,
        wrongCount,
        unansweredCount,
        timeTakenSeconds: authoritativeTimeTaken,
        rank: rankInfo.rank,
        totalParticipants: rankInfo.totalCandidates,
        feedback,
        shareableResultText: `I scored ${score}/${exam.total_marks} (Rank #${rankInfo.rank} of ${rankInfo.totalCandidates.toLocaleString()}) on today's ${exam.title}! Try it: https://prep404.com/m/${exam.id}`,
      };
    } catch (err: any) {
      if (submittedSessionId && sessionExamId) await recordExamSessionFailure(db, sessionExamId, submittedSessionId, 'request_failed').catch(() => undefined);
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 3. PRE-MATERIALIZED QUESTION SET SNAPSHOT API (Chorcha-style Edge Delivery)
  // Single-query instant fetch with Anti-Scraping / Out-of-app access protection
  // =========================================================================
  const handleQuestionSnapshot = async (req: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
    const rawSlug = (req.params.slug || '').trim().toLowerCase();
    
    // Security check: Protect question sets from out-of-app scraping
    const appClientHeader = (req.headers['x-prep404-app-client'] || req.headers['x-client-app'] || req.headers['authorization']) as string | undefined;
    const isAppRequest = !!appClientHeader && (
      appClientHeader.includes('prep404') || 
      appClientHeader.startsWith('Bearer ') || 
      appClientHeader === 'mobile-client'
    );

    if (!isAppRequest) {
      return reply.status(403).send({
        error: 'Forbidden: Access denied. Out-of-app requests without verified Prep404 application credentials are not permitted.',
        code: 'OUT_OF_APP_RESTRICTED'
      });
    }

    // 1. Check Redis / In-Memory Snapshot Cache enforcing temporal window
    const cacheKey = `exam:snapshot:${rawSlug}`;
    const cached = await redis.getSessionKey(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        const startsAt = parsed.startsAt ? new Date(parsed.startsAt).getTime() : 0;
        const endsAt = parsed.endsAt ? new Date(parsed.endsAt).getTime() : Infinity;
        const now = Date.now();
        if (now >= startsAt && now < endsAt) {
          reply.header('X-Cache-Status', 'HIT');
          reply.header('Cache-Control', 'public, max-age=86400');
          return reply.send(sanitizeExamSnapshot(parsed));
        }
      } catch (_) {}
    }

    // 2. Query Postgres exam_snapshots table enforcing active status and temporal validity
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawSlug);
      const query = isUuid
        ? `SELECT s.payload_json, e.is_active, e.starts_at, e.ends_at
           FROM exam_snapshots s
           JOIN exams e ON s.exam_id = e.id
           WHERE (s.exam_id = $1::uuid OR s.slug = $2 OR s.access_key = $2)
             AND e.is_active = true
             AND (e.starts_at IS NULL OR e.starts_at <= now())
             AND (e.ends_at IS NULL OR e.ends_at > now())
           LIMIT 1`
        : `SELECT s.payload_json, e.is_active, e.starts_at, e.ends_at
           FROM exam_snapshots s
           JOIN exams e ON s.exam_id = e.id
           WHERE (s.slug = $1 OR s.access_key = $1 OR s.slug ILIKE $2)
             AND e.is_active = true
             AND (e.starts_at IS NULL OR e.starts_at <= now())
             AND (e.ends_at IS NULL OR e.ends_at > now())
           LIMIT 1`;
      const params = isUuid ? [rawSlug, rawSlug] : [rawSlug, `%${rawSlug}%`];

      const res = await db.query(query, params);
      if (res.rows.length === 0) {
        return reply.status(404).send({ error: `Question set '${rawSlug}' not found or not currently active` });
      }

      const row = res.rows[0];
      const snapshot = sanitizeExamSnapshot({
        ...(typeof row.payload_json === 'object' && row.payload_json !== null ? row.payload_json : {}),
        startsAt: row.starts_at,
        endsAt: row.ends_at,
      });

      let ttl = 86400;
      if (row.ends_at) {
        const remainingSeconds = Math.round((new Date(row.ends_at).getTime() - Date.now()) / 1000);
        if (remainingSeconds > 0) {
          ttl = Math.min(ttl, remainingSeconds);
        }
      }

      // Cache snapshot for duration bounded by exam end time
      await redis.setSessionKey(cacheKey, JSON.stringify(snapshot), ttl);

      reply.header('X-Cache-Status', 'MISS');
      reply.header('Cache-Control', `public, max-age=${ttl}`);
      return reply.send(snapshot);
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  };

  app.get<{ Params: { slug: string } }>('/api/v1/qu/:slug', handleQuestionSnapshot);
  app.get<{ Params: { slug: string } }>('/qu/:slug', handleQuestionSnapshot);
  app.get<{ Params: { slug: string } }>('/api/slug/:slug', handleQuestionSnapshot);

  // 4. Admin / Portal Snapshot Invalidation Hook
  app.post<{ Body: { examId?: string; slug?: string } }>(
    '/api/v1/qu/invalidate',
    { preHandler: [requireStaffRole(['super_admin'])] },
    async (req, reply) => {
      const { examId, slug } = (req.body || {}) as { examId?: string; slug?: string };
      if (examId) await redis.del(`exam:snapshot:${examId.toLowerCase()}`);
      if (slug) await redis.del(`exam:snapshot:${slug.toLowerCase()}`);
      return { success: true, message: 'Snapshot cache invalidated' };
    }
  );
};
