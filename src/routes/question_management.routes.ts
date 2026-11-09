import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Pool } from 'pg';
import crypto from 'crypto';
import { RedisService } from '../redis/redis.service';
import { requireStaffRole } from '../middleware/rbac.middleware';
import { sendInternalError } from '../services/http_errors';

export const questionManagementRoutes: FastifyPluginAsync<{ db: Pool; redis: RedisService }> = async (
  app: FastifyInstance,
  opts: { db: Pool; redis: RedisService }
) => {
  const { db } = opts;

  const audit = async (client: any, actor: any, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) => {
    await client.query(
      `INSERT INTO public.staff_audit_logs (actor_email, actor_role, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [actor.email, actor.role, action, entityType, entityId, JSON.stringify(metadata)]
    );
  };

  const deployableQuestionPredicate = (alias: string) =>
    `${alias}.is_active = true AND ${alias}.review_status = 'approved' AND ${alias}.topic_id IS NOT NULL AND length(trim(COALESCE(${alias}.stem_primary,''))) >= 5 AND length(trim(COALESCE(${alias}.solution_markdown,''))) >= 3 AND CASE WHEN jsonb_typeof(${alias}.options)='array' THEN jsonb_array_length(${alias}.options) >= 2 AND (SELECT count(*) FROM jsonb_array_elements(${alias}.options) AS option_item WHERE COALESCE(option_item->>'is_correct','false')='true') = 1 ELSE false END`;

  const buildShareSnippet = (title: string, slug: string, duration: number, marks: number, neg: number) => {
    return {
      whatsapp: `🏆 *Prep404 Daily Live Model Test is LIVE!*
📚 *Test*: ${title}
⏱️ *Duration*: ${duration} Mins | 🎯 *Total Marks*: ${marks} (-${neg})
📊 *Live Merit Ranking*: Instant national percentiles!
👉 *Take Test Now*: https://prep404.com/m/${slug}
_Powered by Prep404_`,
      telegram: `🔥 **Prep404 Live Model Test**: ${title}
⏱ Duration: ${duration} mins | 🎯 Marks: ${marks} (-${neg})
🔗 Join: https://prep404.com/m/${slug}`,
    };
  };

  app.get('/api/v1/management/question-targets',
    { preHandler: [requireStaffRole(['setter', 'moderator', 'scheduler', 'super_admin'])] }, async (_req, reply) => {
      try {
        const result = await db.query(`SELECT id, COALESCE(NULLIF(short_name,''), full_name) AS name, code
          FROM public.universities WHERE is_active=true ORDER BY COALESCE(NULLIF(short_name,''), full_name)`);
        return { targets: result.rows };
      } catch (err) {
        _req.log.error({ err }, 'Question target options unavailable');
        return reply.status(503).send({ error: 'University targets are unavailable.' });
      }
    });

  // =========================================================================
  // 1. STATS OVERVIEW FOR ADMIN DASHBOARD
  // =========================================================================
  app.get(
    '/api/v1/management/stats',
    { preHandler: [requireStaffRole(['setter', 'moderator', 'scheduler', 'super_admin'])] },
    async (_req, reply: FastifyReply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

      try {
        const [qRes, deployableRes, examRes, subCountRes, subRes] = await Promise.all([
          db.query("SELECT count(*) FROM questions WHERE is_active = true AND review_status = 'approved'"),
          db.query(`SELECT count(*) FROM public.questions q WHERE ${deployableQuestionPredicate('q')}`),
          db.query('SELECT count(*) FROM exams WHERE is_active = true'),
          db.query('SELECT count(*) FROM exam_submissions WHERE is_practice = false'),
          db.query(`
            SELECT s.name, count(q.id) as count 
            FROM academic_subjects s 
            LEFT JOIN questions q ON q.subject_id = s.id AND q.is_active = true AND q.review_status = 'approved'
            GROUP BY s.id, s.name
          `),
        ]);

        const recentExamsRes = await db.query(`
          SELECT id, title, created_at AS "deployedAt" 
          FROM exams 
          ORDER BY created_at DESC 
          LIMIT 5
        `);

        const subjectCounts: Record<string, number> = {};
        subRes.rows.forEach((r) => {
          subjectCounts[r.name] = parseInt(r.count, 10) || 0;
        });

        return {
          success: true,
          stats: {
            totalQuestions: parseInt(qRes.rows[0].count, 10) || 0,
            deployableQuestionCount: parseInt(deployableRes.rows[0].count, 10) || 0,
            activeExamsCount: parseInt(examRes.rows[0].count, 10) || 0,
            totalSubmissions: parseInt(subCountRes.rows[0].count, 10) || 0,
            subjectCounts,
            recentExams: recentExamsRes.rows.map((e) => ({
              slug: e.id,
              title: e.title,
              deployedAt: e.deployedAt,
              shareableUrl: `https://prep404.com/m/${e.id}`,
            })),
          },
        };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // =========================================================================
  // 2. QUESTION BANK POOL & LISTING
  // =========================================================================
  app.get<{
    Querystring: { subjectId?: string; topicId?: string; search?: string; difficulty?: string; institutionId?: string; track?: string; language?: string; readiness?: string; limit?: string; offset?: string };
  }>(
    '/api/v1/management/questions',
    { preHandler: [requireStaffRole(['setter', 'moderator', 'scheduler', 'super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

      const { subjectId, topicId, search, difficulty, institutionId, track, language, readiness = 'all', limit = '50', offset = '0' } = req.query;
      if (!['all', 'exam_ready', 'needs_review'].includes(readiness)) return reply.status(400).send({ error: 'Invalid readiness filter.' });
      const parsedLimit = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
      const parsedOffset = Math.max(0, parseInt(offset, 10) || 0);

      try {
        let query = `
          SELECT 
            q.id,
            q.subject_id AS "subjectId",
            s.name AS "subjectName",
            q.topic_id AS "topicId",
            t.name AS "topicName",
            q.stem_primary AS "questionText",
            (q.stem_primary LIKE '%$%' OR q.stem_primary LIKE '%\\%') AS "hasMath",
            q.options,
            q.solution_markdown AS "explanation",
            q.difficulty_rating AS "difficulty",
            q.target_university_id AS "targetUniversityId",
            u.short_name AS "targetUniversityName",
            q.target_track AS "targetTrack",
            q.language,
            q.is_active AS "isActive",
            CASE WHEN jsonb_typeof(q.options)='array' THEN jsonb_array_length(q.options) ELSE 0 END::int AS "optionCount",
            CASE WHEN jsonb_typeof(q.options)='array' THEN (SELECT count(*) FROM jsonb_array_elements(q.options) AS option_item WHERE COALESCE(option_item->>'is_correct','false')='true') ELSE 0 END::int AS "correctOptionCount",
            (${deployableQuestionPredicate('q')}) AS "isExamReady",
            COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'examId', e.id,
                    'examTitle', e.title,
                    'track', e.track,
                    'status', CASE 
                      WHEN e.is_draft = true THEN 'draft'
                      WHEN e.ends_at < NOW() THEN 'ended'
                      WHEN e.starts_at <= NOW() AND (e.ends_at IS NULL OR e.ends_at >= NOW()) THEN 'live'
                      ELSE 'scheduled'
                    END,
                    'startsAt', e.starts_at,
                    'endsAt', e.ends_at,
                    'isUpcoming', (e.starts_at > NOW() OR (e.is_draft = false AND e.starts_at IS NOT NULL AND e.ends_at >= NOW()))
                  ) ORDER BY e.created_at DESC
                )
                FROM exam_questions eq
                JOIN exams e ON e.id = eq.exam_id
                WHERE eq.question_id = q.id
              ),
              '[]'::jsonb
            ) AS "examAppearances",
            q.created_at AS "createdAt"
          FROM questions q
          LEFT JOIN academic_subjects s ON s.id = q.subject_id
          LEFT JOIN academic_topics t ON t.id = q.topic_id
          LEFT JOIN public.universities u ON u.id=q.target_university_id
          WHERE q.is_active = true AND q.review_status = 'approved'
        `;
        const params: any[] = [];

        if (readiness === 'exam_ready') query += ` AND (${deployableQuestionPredicate('q')})`;
        if (readiness === 'needs_review') query += ` AND NOT (${deployableQuestionPredicate('q')})`;

        if (subjectId && subjectId !== 'all') {
          params.push(subjectId);
          query += ` AND (q.subject_id::text = $${params.length}::text OR s.slug = $${params.length}::text OR s.name ILIKE $${params.length}::text)`;
        }
        if (topicId && topicId !== 'all') {
          params.push(topicId);
          query += ` AND (q.topic_id::text = $${params.length}::text OR t.slug = $${params.length}::text OR t.name ILIKE $${params.length}::text)`;
        }
        if (difficulty && difficulty !== 'all') {
          const diffNum = parseFloat(difficulty);
          if (!isNaN(diffNum)) {
            params.push(diffNum);
            query += ` AND ABS(q.difficulty_rating - $${params.length}) < 0.5`;
          }
        }
        if (institutionId && institutionId !== 'all') {
          if (!z.string().uuid().safeParse(institutionId).success) return reply.status(400).send({ error: 'Invalid institutionId.' });
          params.push(institutionId);
          query += ` AND q.target_university_id=$${params.length}::uuid`;
        }
        if (track && track !== 'all') {
          if (!['engineering', 'humanities', 'business', 'sciences', 'pharmacy', 'architecture', 'law'].includes(track)) return reply.status(400).send({ error: 'Invalid track.' });
          params.push(track);
          query += ` AND q.target_track=$${params.length}`;
        }
        if (language && language !== 'all') {
          if (!['bangla', 'english', 'mixed'].includes(language)) return reply.status(400).send({ error: 'Invalid language.' });
          params.push(language);
          query += ` AND q.language=$${params.length}`;
        }
        if (search && search.trim().length > 0) {
          params.push(`%${search.trim()}%`);
          query += ` AND (q.stem_primary ILIKE $${params.length} OR q.solution_markdown ILIKE $${params.length} OR q.id::text ILIKE $${params.length} OR q.options::text ILIKE $${params.length})`;
        }

        const countQuery = `SELECT count(*) FROM (${query}) AS sub`;
        const countRes = await db.query(countQuery, params);
        const total = parseInt(countRes.rows[0].count, 10) || 0;

        params.push(parsedLimit, parsedOffset);
        query += ` ORDER BY q.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

        const result = await db.query(query, params);

        return {
          success: true,
          total,
          count: result.rows.length,
          questions: result.rows,
        };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // =========================================================================
  // 3. QUESTION CREATION & UPDATE
  // =========================================================================
  const CreateQuestionSchema = z.object({
    subjectId: z.string().uuid(),
    topicId: z.string().uuid(),
    questionText: z.string().trim().min(5).max(10000),
    options: z
      .array(
        z.object({
          id: z.string().optional(),
          text: z.string().trim().min(1).max(2000),
          isCorrect: z.boolean().optional(),
        })
      )
      .min(2).max(8),
    correctOption: z.string().min(1),
    explanation: z.string().trim().min(3).max(20000),
    difficulty: z.number().min(0.5).max(2.5).default(1.0),
    targetUniversityId: z.string().uuid().nullable().optional(),
    targetTrack: z.enum(['engineering', 'humanities', 'business', 'sciences', 'pharmacy', 'architecture', 'law']).nullable().optional(),
    language: z.enum(['bangla', 'english', 'mixed']).default('mixed'),
  });

  app.put('/api/v1/management/questions/:id',
    { preHandler: [requireStaffRole(['setter', 'moderator', 'super_admin'])] }, async (req, reply) => {
      const parse = CreateQuestionSchema.safeParse(req.body);
      if (!parse.success) return reply.status(400).send({ error: parse.error.errors[0].message });
      const data = parse.data;
      const options = data.options.map((option, index) => {
        const key = option.id || String.fromCharCode(65 + index);
        return { id: `opt_${Date.now()}_${index}`, key_original: key, text: option.text, is_correct: option.isCorrect ?? key === data.correctOption };
      });
      if (!options.some((option) => option.is_correct)) return reply.status(400).send({ error: 'Choose the correct answer before submitting.' });
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const found = await client.query(`SELECT id, subject_id, topic_id, stem_primary, options, solution_markdown, difficulty_rating, review_status, is_active FROM public.questions WHERE id=$1::uuid FOR UPDATE`, [(req.params as any).id]);
        if (!found.rowCount) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Question not found.' }); }
        const before = found.rows[0];
        const updated = await client.query(`UPDATE public.questions SET subject_id=$2::uuid, topic_id=$3::uuid, stem_primary=$4, options=$5::jsonb, solution_markdown=$6, difficulty_rating=$7, target_university_id=$8::uuid, target_track=$9, language=$10, is_active=false, review_status='under_review', reviewed_by=NULL, reviewed_at=NULL, review_notes=NULL WHERE id=$1::uuid RETURNING id`, [(req.params as any).id, data.subjectId, data.topicId, data.questionText, JSON.stringify(options), data.explanation, data.difficulty, data.targetUniversityId || null, data.targetTrack || null, data.language]);
        await audit(client, (req as any).staffUser, 'question.revised', 'question', updated.rows[0].id, {
          before: { subjectId: before.subject_id, topicId: before.topic_id, questionText: before.stem_primary, options: before.options, explanation: before.solution_markdown, difficulty: Number(before.difficulty_rating), targetUniversityId: before.target_university_id, targetTrack: before.target_track, language: before.language, reviewStatus: before.review_status, wasActive: before.is_active },
          after: { subjectId: data.subjectId, topicId: data.topicId, questionText: data.questionText, options, explanation: data.explanation, difficulty: data.difficulty, targetUniversityId: data.targetUniversityId || null, targetTrack: data.targetTrack || null, language: data.language, reviewStatus: 'under_review' },
        });
        await client.query('COMMIT');
        return { success: true, id: updated.rows[0].id, status: 'under_review' };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err.code === '22P02') return reply.status(400).send({ error: 'Invalid question identifier.' });
        req.log.error({ err }, 'Question revision failed');
        return reply.status(500).send({ error: 'Unable to submit question correction.' });
      } finally { client.release(); }
    });

  app.get('/api/v1/management/questions/:id/history',
    { preHandler: [requireStaffRole(['moderator', 'super_admin'])] }, async (req, reply) => {
      try {
        const result = await db.query(`SELECT id, action, actor_email AS "actorEmail", actor_role AS "actorRole", metadata, created_at AS "createdAt" FROM public.staff_audit_logs WHERE entity_type='question' AND entity_id=$1 AND action IN ('question.created','question.revised','question.approved','question.rejected') ORDER BY id DESC LIMIT 50`, [(req.params as any).id]);
        return { history: result.rows };
      } catch (err: any) {
        if (err.code === '22P02') return reply.status(400).send({ error: 'Invalid question identifier.' });
        req.log.error({ err }, 'Question history unavailable');
        return reply.status(500).send({ error: 'Unable to load question history.' });
      }
    });

  app.post(
    '/api/v1/management/questions/create',
    { preHandler: [requireStaffRole(['setter', 'moderator', 'super_admin'])] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parse = CreateQuestionSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ error: parse.error.errors[0].message });
      }

      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

      const data = parse.data;
      const formattedOptions = data.options.map((opt, idx) => {
        const key = opt.id || String.fromCharCode(65 + idx);
        const isCorr = opt.isCorrect ?? (key === data.correctOption);
        return {
          id: `opt_${Date.now()}_${idx}`,
          key_original: key,
          text: opt.text,
          is_correct: isCorr,
        };
      });

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const res = await client.query(`
          INSERT INTO questions (
            item_type, subject_id, topic_id, stem_primary,
            options, solution_markdown, difficulty_rating, target_university_id, target_track, language, is_active, review_status
          ) VALUES (
            'mcq_standalone', $1::uuid, NULLIF($2, '')::uuid, $3,
            $4::jsonb, $5, $6, $7::uuid, $8, $9, false, 'under_review'
          ) RETURNING *;
        `, [data.subjectId, data.topicId || null, data.questionText, JSON.stringify(formattedOptions), data.explanation, data.difficulty, data.targetUniversityId || null, data.targetTrack || null, data.language]);

        const actor = (req as any).staffUser;
        await audit(client, actor, 'question.created', 'question', res.rows[0].id, { status: 'under_review' });
        await client.query('COMMIT');
        return {
          success: true,
          message: 'Question inserted into Supabase database',
          question: res.rows[0],
        };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        return sendInternalError(reply, err);
      } finally { client.release(); }
    }
  );

  // =========================================================================
  // 4. ACTIVE EXAMS & TELEMETRY
  // =========================================================================
  app.get(
    '/api/v1/management/exams/active',
    { preHandler: [requireStaffRole(['setter', 'moderator', 'scheduler', 'super_admin'])] },
    async (_req, reply: FastifyReply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

      try {
        const res = await db.query(`
          SELECT 
            e.id,
            e.id AS "slug",
            e.title,
            e.track,
            ROUND(e.duration_seconds / 60) AS "durationMinutes",
            e.total_marks AS "totalMarks",
            COALESCE(e.negative_mark_per_question, 0.25) AS "negativeMark",
            e.starts_at AS "startsAt",
            e.ends_at AS "endsAt",
            CASE
              WHEN COALESCE(e.is_draft, false) THEN 'draft'
              WHEN NOT COALESCE(e.is_active, false) THEN 'cancelled'
              WHEN e.ends_at IS NOT NULL AND e.ends_at <= now() THEN 'completed'
              WHEN e.starts_at IS NOT NULL AND e.starts_at > now() THEN 'scheduled'
              ELSE 'live'
            END AS status,
            e.is_active AS "isActive",
            e.is_draft AS "isDraft",
            e.target_university_id AS "targetUniversityId",
            e.created_at AS "deployedAt",
            (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS "questionCount",
            (SELECT COUNT(*) FROM exam_submissions es WHERE es.exam_id = e.id) AS "totalSubmissions",
            (SELECT COUNT(*) FROM exam_submissions es WHERE es.exam_id = e.id AND es.is_practice = false) AS "liveSubmissions",
            CONCAT('https://prep404.com/m/', e.id) AS "shareableUrl"
          FROM exams e
          ORDER BY (SELECT COUNT(*) FROM exam_submissions es WHERE es.exam_id = e.id) DESC, e.created_at DESC;
        `);

        return {
          success: true,
          count: res.rows.length,
          exams: res.rows,
        };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  app.post('/api/v1/management/exams/:slug/cancel',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] }, async (req, reply) => {
      const client = await db.connect();
      const actor = (req as any).staffUser;
      try {
        await client.query('BEGIN');
        const found = await client.query(`SELECT id, title, is_active, ends_at FROM public.exams WHERE id=$1::uuid FOR UPDATE`, [(req.params as any).slug]);
        if (!found.rowCount) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Exam not found.' }); }
        const exam = found.rows[0];
        if (!exam.is_active || (exam.ends_at && new Date(exam.ends_at).getTime() <= Date.now())) {
          await client.query('ROLLBACK');
          return reply.status(409).send({ error: 'Only scheduled or live exams can be cancelled.' });
        }
        await client.query(`UPDATE public.exams SET is_active=false WHERE id=$1::uuid`, [exam.id]);
        await audit(client, actor, 'exam.cancelled', 'exam', exam.id, { title: exam.title });
        await client.query('COMMIT');
        return { success: true, examId: exam.id, status: 'cancelled' };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err.code === '22P02') return reply.status(400).send({ error: 'Invalid exam identifier.' });
        req.log.error({ err }, 'Exam cancellation failed');
        return reply.status(500).send({ error: 'Unable to cancel exam.' });
      } finally { client.release(); }
    });

  app.post('/api/v1/management/exams/:slug/reschedule',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] }, async (req, reply) => {
      const body = z.object({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }) }).safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: body.error.errors[0].message });
      const startsAt = new Date(body.data.startsAt);
      const endsAt = new Date(body.data.endsAt);
      if (startsAt <= new Date() || endsAt <= startsAt) return reply.status(400).send({ error: 'Choose a future start time and a later end time.' });
      if (endsAt.getTime() - startsAt.getTime() > 30 * 24 * 60 * 60 * 1000) return reply.status(400).send({ error: 'Exam scheduling windows cannot exceed 30 days.' });
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const found = await client.query(`SELECT id, title, is_active, starts_at FROM public.exams WHERE id=$1::uuid FOR UPDATE`, [(req.params as any).slug]);
        if (!found.rowCount) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Exam not found.' }); }
        const exam = found.rows[0];
        if (!exam.is_active || !exam.starts_at || new Date(exam.starts_at).getTime() <= Date.now()) {
          await client.query('ROLLBACK');
          return reply.status(409).send({ error: 'Only scheduled exams can be rescheduled.' });
        }
        const submissions = await client.query(`SELECT COUNT(*)::int AS count FROM public.exam_submissions WHERE exam_id=$1::uuid AND is_practice=false`, [exam.id]);
        if (submissions.rows[0].count > 0) {
          await client.query('ROLLBACK');
          return reply.status(409).send({ error: 'An exam with submissions cannot be rescheduled.' });
        }
        await client.query(`UPDATE public.exams SET starts_at=$2, ends_at=$3 WHERE id=$1::uuid`, [exam.id, startsAt.toISOString(), endsAt.toISOString()]);
        await audit(client, (req as any).staffUser, 'exam.rescheduled', 'exam', exam.id, { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
        await client.query('COMMIT');
        return { success: true, examId: exam.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err.code === '22P02') return reply.status(400).send({ error: 'Invalid exam identifier.' });
        req.log.error({ err }, 'Exam rescheduling failed');
        return reply.status(500).send({ error: 'Unable to reschedule exam.' });
      } finally { client.release(); }
    });

  app.get<{
    Params: { slug: string };
  }>(
    '/api/v1/management/exams/:slug/telemetry',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] },
    async (req, reply: FastifyReply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

      try {
        const examRes = await db.query(
          `SELECT id, title, total_marks AS "totalMarks"
           FROM exams WHERE id = $1::uuid LIMIT 1`,
          [req.params.slug]
        );
        if (examRes.rows.length === 0) {
          return reply.status(404).send({ error: 'Exam not found' });
        }

        const exam = examRes.rows[0];
        const queryPractice = (req.query as any)?.includePractice === 'true';
        const totalCountCheck = await db.query(
          `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_practice = false) AS live FROM exam_submissions WHERE exam_id = $1::uuid`,
          [exam.id]
        );
        const hasLive = Number(totalCountCheck.rows[0]?.live || 0) > 0;
        const includePractice = queryPractice || (!hasLive && Number(totalCountCheck.rows[0]?.total || 0) > 0);

        const [countRes, leaderboardRes, summaryRes] = await Promise.all([
          db.query(
            `SELECT COUNT(*) AS count
             FROM exam_submissions
             WHERE exam_id = $1::uuid AND (is_practice = false OR $2 = true)`,
            [exam.id, includePractice]
          ),
          db.query(
            `SELECT s.score, s.time_taken_seconds AS "timeTaken",
                    COALESCE(s.candidate_name, u.full_name, 'Learner') AS "candidateName"
             FROM exam_submissions s
             LEFT JOIN users u ON u.id = s.user_id
             WHERE s.exam_id = $1::uuid AND (s.is_practice = false OR $2 = true)
             ORDER BY s.score DESC NULLS LAST, s.time_taken_seconds ASC NULLS LAST
             LIMIT 50`,
            [exam.id, includePractice]
          ),
          db.query(
            `SELECT COUNT(*) AS count, ROUND(AVG(score)::numeric,2) AS "averageScore",
                    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY score)::numeric,2) AS "medianScore",
                    MIN(score) AS "lowestScore", MAX(score) AS "highestScore",
                    ROUND(AVG(time_taken_seconds)::numeric) AS "averageTimeSeconds",
                    COUNT(*) FILTER (WHERE score / NULLIF($2::double precision,0) < 0.25) AS "under25Percent",
                    COUNT(*) FILTER (WHERE score / NULLIF($2::double precision,0) >= 0.25 AND score / NULLIF($2::double precision,0) < 0.5) AS "from25To49Percent",
                    COUNT(*) FILTER (WHERE score / NULLIF($2::double precision,0) >= 0.5 AND score / NULLIF($2::double precision,0) < 0.75) AS "from50To74Percent",
                    COUNT(*) FILTER (WHERE score / NULLIF($2::double precision,0) >= 0.75) AS "atLeast75Percent"
             FROM exam_submissions WHERE exam_id=$1::uuid AND (is_practice = false OR $3 = true)`,
            [exam.id, Number(exam.totalMarks) || 0, includePractice]
          ),
        ]);

        let sessionMetrics: { available: boolean; starts: number; completions: number; failures: number; completionRate: number | null } = {
          available: false, starts: 0, completions: 0, failures: 0, completionRate: null,
        };
        try {
          const sessions = await db.query(`SELECT COUNT(*) AS starts,
              COUNT(*) FILTER (WHERE submitted_at IS NOT NULL) AS completions,
              COALESCE(SUM(failure_count), 0) AS failures
            FROM public.exam_session_telemetry WHERE exam_id=$1::uuid AND started_at >= now() - INTERVAL '30 days'`, [exam.id]);
          const starts = Number(sessions.rows[0]?.starts || 0);
          const completions = Number(sessions.rows[0]?.completions || 0);
          sessionMetrics = { available: true, starts, completions, failures: Number(sessions.rows[0]?.failures || 0), completionRate: starts ? Math.round(completions / starts * 1000) / 10 : null };
        } catch (err) {
          req.log.warn({ err, examId: exam.id }, 'Exam session telemetry table unavailable');
        }

        return {
          slug: exam.id,
          totalSubmissions: parseInt(countRes.rows[0]?.count || '0', 10),
          totalMarks: Number(exam.totalMarks) || 0,
          summary: {
            totalSubmissions: Number(summaryRes.rows[0]?.count || 0),
            averageScore: summaryRes.rows[0]?.averageScore == null ? null : Number(summaryRes.rows[0].averageScore),
            medianScore: summaryRes.rows[0]?.medianScore == null ? null : Number(summaryRes.rows[0].medianScore),
            lowestScore: summaryRes.rows[0]?.lowestScore == null ? null : Number(summaryRes.rows[0].lowestScore),
            highestScore: summaryRes.rows[0]?.highestScore == null ? null : Number(summaryRes.rows[0].highestScore),
            averageTimeSeconds: summaryRes.rows[0]?.averageTimeSeconds == null ? null : Number(summaryRes.rows[0].averageTimeSeconds),
            scoreDistribution: [
              { label: 'Below 25%', count: Number(summaryRes.rows[0]?.under25Percent || 0) },
              { label: '25–49%', count: Number(summaryRes.rows[0]?.from25To49Percent || 0) },
              { label: '50–74%', count: Number(summaryRes.rows[0]?.from50To74Percent || 0) },
              { label: '75%+', count: Number(summaryRes.rows[0]?.atLeast75Percent || 0) },
            ],
          },
          sessions: sessionMetrics,
          leaderboard: leaderboardRes.rows.map((entry, index) => ({
            rank: index + 1,
            candidateName: entry.candidateName,
            score: Number(entry.score) || 0,
            timeTaken: entry.timeTaken == null ? undefined : Number(entry.timeTaken),
          })),
          generatedAt: new Date().toISOString(),
        };
      } catch (err: any) {
        if (err.code === '22P02') return reply.status(400).send({ error: 'Invalid exam identifier' });
        req.log.error({ err }, 'Failed to load admin exam telemetry');
        return reply.status(500).send({ error: 'Unable to load exam telemetry' });
      }
    }
  );

  app.get('/api/v1/management/exams/:slug/export.csv',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] }, async (req, reply) => {
      const slug = z.string().uuid().safeParse((req.params as any).slug);
      if (!slug.success) return reply.status(400).send({ error: 'Invalid exam identifier.' });
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const client = await db.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const examResult = await client.query('SELECT id, total_marks FROM public.exams WHERE id=$1::uuid', [slug.data]);
        if (!examResult.rowCount) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Exam not found.' }); }
        const results = await client.query(`
          SELECT row_number() OVER (ORDER BY s.score DESC NULLS LAST, s.time_taken_seconds ASC NULLS LAST, s.submitted_at ASC)::int AS rank,
            COALESCE(s.candidate_name, u.full_name, 'Learner') AS "candidateName",
            s.score, s.time_taken_seconds AS "timeTaken"
          FROM public.exam_submissions s
          LEFT JOIN public.users u ON u.id=s.user_id
          WHERE s.exam_id=$1::uuid AND s.is_practice=false
          ORDER BY s.score DESC NULLS LAST, s.time_taken_seconds ASC NULLS LAST, s.submitted_at ASC
          LIMIT 10001
        `, [slug.data]);
        const truncatedAtLimit = results.rows.length > 10000;
        const exportRows = results.rows.slice(0, 10000);
        await audit(client, (req as any).staffUser, 'exam.results_exported', 'exam', slug.data, {
          format: 'csv', rows: exportRows.length, rowLimit: 10000,
          truncatedAtLimit,
          fields: ['rank', 'candidate_name', 'score', 'total_marks', 'time_taken_seconds'],
        });
        await client.query('COMMIT');

        const textCell = (value: unknown) => {
          const safe = String(value ?? '').replace(/^[\s]*[=+@-]/, (prefix) => `'${prefix}`);
          return `"${safe.replace(/"/g, '""')}"`;
        };
        const numberCell = (value: unknown) => {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? String(parsed) : '';
        };
        const rows = [
          ['Rank', 'Candidate', 'Score', 'Total marks', 'Time (seconds)'].map(textCell).join(','),
          ...exportRows.map((row) => [numberCell(row.rank), textCell(row.candidateName), numberCell(row.score), numberCell(examResult.rows[0].total_marks), numberCell(row.timeTaken)].join(',')),
        ];
        reply.header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="prep404-exam-${slug.data}-results.csv"`)
          .header('Cache-Control', 'no-store')
          .header('X-Export-Truncated', String(truncatedAtLimit));
        return reply.send(`\uFEFF${rows.join('\r\n')}`);
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err.code === '22P02') return reply.status(400).send({ error: 'Invalid exam identifier.' });
        req.log.error({ err }, 'Exam result export failed');
        return reply.status(503).send({ error: 'Unable to export exam results.' });
      } finally { client.release(); }
    });

  // =========================================================================
  // 5. DEPLOY DAILY MODEL TEST
  // =========================================================================
  const DeployDailyExamSchema = z.object({
    title: z.string().trim().min(5).max(120),
    track: z.string().trim().min(1).max(80).default('Private University'),
    durationMinutes: z.number().int().min(1).max(600).default(30),
    totalMarks: z.number().positive().max(2000).default(50),
    negativeMark: z.number().min(0).max(100).default(0.25),
    questionCount: z.number().int().min(1).max(200).default(25),
    targetUniversityId: z.string().uuid().optional().nullable(),
    questionIds: z.array(z.string().uuid()).optional(),
    startsAt: z.string().optional().nullable(),
    endsAt: z.string().optional().nullable(),
  }).refine((exam) => exam.negativeMark <= exam.totalMarks, {
    path: ['negativeMark'],
    message: 'Negative marking cannot exceed the total marks.',
  });

  app.post('/api/v1/management/exams/drafts',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] }, async (req, reply) => {
      const parsed = DeployDailyExamSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const { title, track, durationMinutes, totalMarks, negativeMark, questionCount, targetUniversityId, questionIds, startsAt, endsAt } = parsed.data;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        let selectedIds: string[] = [];
        if (questionIds && questionIds.length > 0) {
          selectedIds = questionIds;
        } else {
          const seed1 = crypto.randomUUID();
          const questions = await client.query(`SELECT q.id FROM public.questions q WHERE ${deployableQuestionPredicate('q')} ORDER BY (q.id >= $2::uuid) DESC, q.id ASC LIMIT $1`, [questionCount, seed1]);
          if (questions.rows.length < questionCount) {
            await client.query('ROLLBACK');
            return reply.status(409).send({ error: `Only ${questions.rows.length} approved, exam-ready questions are available; ${questionCount} are required.` });
          }
          selectedIds = questions.rows.map((row) => row.id);
        }

        const startIso = startsAt ? new Date(startsAt).toISOString() : null;
        const endIso = endsAt ? new Date(endsAt).toISOString() : null;

        const exam = await client.query(`
          INSERT INTO public.exams (title, track, exam_type, duration_seconds, total_marks,
            negative_mark_per_question, starts_at, ends_at, is_active, is_draft,
            draft_question_count, target_university_id)
          VALUES ($1, $2, 'daily_live', $3, $4, $5, $8, $9, false, true, $7, NULLIF($6, '')::uuid)
          RETURNING id
        `, [title, track, durationMinutes * 60, totalMarks, negativeMark, targetUniversityId || null, selectedIds.length, startIso, endIso]);
        const examId = exam.rows[0].id;

        await client.query(`INSERT INTO public.exam_questions (exam_id, question_id, question_order)
          SELECT $1::uuid, selected.id, selected.position::integer
          FROM UNNEST($2::uuid[]) WITH ORDINALITY AS selected(id, position)`, [examId, selectedIds]);
        await audit(client, (req as any).staffUser, 'exam.draft_created', 'exam', examId, { questionCount: selectedIds.length, track });
        await client.query('COMMIT');
        return { success: true, examId, status: 'draft', linkedQuestionCount: selectedIds.length };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        req.log.error({ err }, 'Exam draft creation failed');
        return reply.status(503).send({ error: 'Unable to save the exam draft.' });
      } finally { client.release(); }
    });

  app.post('/api/v1/management/exams/:slug/publish',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] }, async (req, reply) => {
      const body = z.object({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }) }).safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: body.error.errors[0].message });
      const startsAt = new Date(body.data.startsAt);
      const endsAt = new Date(body.data.endsAt);
      if (startsAt <= new Date() || endsAt <= startsAt || endsAt.getTime() - startsAt.getTime() > 30 * 24 * 60 * 60 * 1000) {
        return reply.status(400).send({ error: 'Choose a future start and later end within a 30-day scheduling window.' });
      }
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const found = await client.query('SELECT id, title, is_draft, draft_question_count FROM public.exams WHERE id=$1::uuid FOR UPDATE', [(req.params as any).slug]);
        if (!found.rowCount) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Exam not found.' }); }
        const exam = found.rows[0];
        if (!exam.is_draft) { await client.query('ROLLBACK'); return reply.status(409).send({ error: 'Only an unpublished draft can be published.' }); }
        const quality = await client.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE ${deployableQuestionPredicate('q')})::int AS ready
          FROM public.exam_questions eq JOIN public.questions q ON q.id=eq.question_id WHERE eq.exam_id=$1::uuid`, [exam.id]);
        if (quality.rows[0].total < 1 || quality.rows[0].total !== exam.draft_question_count || quality.rows[0].ready !== quality.rows[0].total) {
          await client.query('ROLLBACK');
          return reply.status(409).send({ error: 'This draft includes questions that are no longer approved and exam-ready. Create a fresh draft before publishing.' });
        }
        await client.query('UPDATE public.exams SET is_draft=false, is_active=true, starts_at=$2, ends_at=$3 WHERE id=$1::uuid', [exam.id, startsAt.toISOString(), endsAt.toISOString()]);
        await audit(client, (req as any).staffUser, 'exam.published', 'exam', exam.id, { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), questionCount: quality.rows[0].total });
        await client.query('COMMIT');
        return { success: true, examId: exam.id, status: 'scheduled', startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err.code === '22P02') return reply.status(400).send({ error: 'Invalid exam identifier.' });
        req.log.error({ err }, 'Exam draft publication failed');
        return reply.status(503).send({ error: 'Unable to publish this exam draft.' });
      } finally { client.release(); }
    });

  app.post(
    '/api/v1/management/exams/deploy-daily',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parse = DeployDailyExamSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ error: parse.error.errors[0].message });
      }

      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

      const { title, track, durationMinutes, totalMarks, negativeMark, questionCount, targetUniversityId, questionIds, startsAt, endsAt } = parse.data;

      const client = await db.connect();
      try {
        await client.query('BEGIN');

        let selectedIds: string[] = [];
        if (questionIds && questionIds.length > 0) {
          selectedIds = questionIds;
        } else {
          const seed2 = crypto.randomUUID();
          const qRes = await client.query(`
            SELECT q.id FROM questions q
            WHERE ${deployableQuestionPredicate('q')}
            ORDER BY (q.id >= $2::uuid) DESC, q.id ASC
            LIMIT $1;
          `, [questionCount, seed2]);
          if (qRes.rows.length < questionCount) {
            await client.query('ROLLBACK');
            return reply.status(409).send({
              error: `Only ${qRes.rows.length} approved, exam-ready questions are available; ${questionCount} are required.`,
            });
          }
          selectedIds = qRes.rows.map((row) => row.id);
        }

        const startIso = startsAt ? new Date(startsAt).toISOString() : new Date().toISOString();
        const endIso = endsAt ? new Date(endsAt).toISOString() : new Date(Date.now() + 7 * 86400000).toISOString();

        const examIns = await client.query(`
          INSERT INTO exams (
            title, track, exam_type, duration_seconds, total_marks,
            negative_mark_per_question, starts_at, ends_at, is_active, target_university_id, draft_question_count
          ) VALUES ($1, $2, 'daily_live', $3, $4, $5, $7, $8, true, NULLIF($6, '')::uuid, $9)
          RETURNING *;
        `, [title, track, durationMinutes * 60, totalMarks, negativeMark, targetUniversityId || null, startIso, endIso, selectedIds.length]);

        const examId = examIns.rows[0].id;

        await client.query(`
          INSERT INTO exam_questions (exam_id, question_id, question_order)
          SELECT $1::uuid, selected.id, selected.position::integer
          FROM UNNEST($2::uuid[]) WITH ORDINALITY AS selected(id, position)
          ON CONFLICT DO NOTHING;
        `, [examId, selectedIds]);

        await audit(client, (req as any).staffUser, 'exam.deployed', 'exam', examId, { questionCount: selectedIds.length, track });

        await client.query('COMMIT');

        const shareableUrl = `https://prep404.com/m/${examId}`;
        const snippets = buildShareSnippet(title, examId, durationMinutes, totalMarks, negativeMark);

        return {
          success: true,
          message: 'Model test deployed to Supabase database and ready for candidates!',
          examId,
          shareableUrl,
          exam: examIns.rows[0],
          linkedQuestionCount: selectedIds.length,
          socialSnippets: snippets,
        };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        return sendInternalError(reply, err);
      } finally {
        client.release();
      }
    }
  );

  // Get Questions Linked to an Exam
  app.get<{ Params: { slug: string } }>(
    '/api/v1/management/exams/:slug/questions',
    { preHandler: [requireStaffRole(['setter', 'moderator', 'scheduler', 'super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      try {
        const res = await db.query(`
          SELECT 
            q.id,
            q.stem_primary AS "questionText",
            q.options,
            q.difficulty_rating AS "difficulty",
            eq.question_order AS "questionOrder",
            s.id AS "subjectId",
            s.name AS "subjectName",
            t.id AS "topicId",
            t.name AS "topicName"
          FROM public.exam_questions eq
          JOIN public.questions q ON q.id = eq.question_id
          LEFT JOIN public.academic_subjects s ON s.id = q.subject_id
          LEFT JOIN public.academic_topics t ON t.id = q.topic_id
          WHERE eq.exam_id = $1::uuid
          ORDER BY eq.question_order ASC;
        `, [req.params.slug]);
        return { success: true, count: res.rows.length, questions: res.rows };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // Update Exam metadata, schedule, and optionally linked questions
  app.put<{ Params: { slug: string } }>(
    '/api/v1/management/exams/:slug',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const schema = z.object({
        title: z.string().trim().min(3).max(200).optional(),
        track: z.string().trim().max(100).optional(),
        durationMinutes: z.number().int().min(1).max(600).optional(),
        totalMarks: z.number().positive().max(2000).optional(),
        negativeMark: z.number().min(0).max(100).optional(),
        targetUniversityId: z.string().uuid().optional().nullable(),
        startsAt: z.string().optional().nullable(),
        endsAt: z.string().optional().nullable(),
        isActive: z.boolean().optional(),
        isDraft: z.boolean().optional(),
        questionIds: z.array(z.string().uuid()).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      const d = parsed.data;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const examCheck = await client.query('SELECT id FROM public.exams WHERE id = $1::uuid FOR UPDATE', [req.params.slug]);
        if (!examCheck.rowCount) {
          await client.query('ROLLBACK');
          return reply.status(404).send({ error: 'Exam not found' });
        }

        const updateRes = await client.query(`
          UPDATE public.exams
          SET
            title = COALESCE($2, title),
            track = COALESCE($3, track),
            duration_seconds = CASE WHEN $4::int IS NOT NULL THEN $4::int * 60 ELSE duration_seconds END,
            total_marks = COALESCE($5, total_marks),
            negative_mark_per_question = COALESCE($6, negative_mark_per_question),
            target_university_id = CASE WHEN $7::text IS NOT NULL THEN NULLIF($7::text, '')::uuid ELSE target_university_id END,
            starts_at = CASE WHEN $8::text IS NOT NULL THEN NULLIF($8::text, '')::timestamptz ELSE starts_at END,
            ends_at = CASE WHEN $9::text IS NOT NULL THEN NULLIF($9::text, '')::timestamptz ELSE ends_at END,
            is_active = COALESCE($10, is_active),
            is_draft = COALESCE($11, is_draft)
          WHERE id = $1::uuid
          RETURNING *;
        `, [
          req.params.slug,
          d.title,
          d.track,
          d.durationMinutes,
          d.totalMarks,
          d.negativeMark,
          d.targetUniversityId === undefined ? null : d.targetUniversityId,
          d.startsAt === undefined ? null : d.startsAt,
          d.endsAt === undefined ? null : d.endsAt,
          d.isActive,
          d.isDraft,
        ]);

        if (d.questionIds && Array.isArray(d.questionIds)) {
          await client.query('DELETE FROM public.exam_questions WHERE exam_id = $1::uuid', [req.params.slug]);
          if (d.questionIds.length > 0) {
            await client.query(`
              INSERT INTO public.exam_questions (exam_id, question_id, question_order)
              SELECT $1::uuid, selected.id, selected.position::integer
              FROM UNNEST($2::uuid[]) WITH ORDINALITY AS selected(id, position)
            `, [req.params.slug, d.questionIds]);
          }
          await client.query('UPDATE public.exams SET draft_question_count = $2 WHERE id = $1::uuid', [req.params.slug, d.questionIds.length]);
        }

        await audit(client, (req as any).staffUser, 'exam.updated', 'exam', req.params.slug, {
          title: d.title,
          questionCount: d.questionIds ? d.questionIds.length : undefined,
        });

        await client.query('COMMIT');
        return { success: true, exam: updateRes.rows[0] };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        return sendInternalError(reply, err);
      } finally {
        client.release();
      }
    }
  );
};
