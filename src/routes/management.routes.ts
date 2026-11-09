import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../redis/redis.service';
import { requireStaffRole } from '../middleware/rbac.middleware';
import { hashStaffPassword, STAFF_PASSWORD_MIN_LENGTH } from '../services/staff_credentials.service';
import { getExamSessionRetentionState } from '../services/exam_session_telemetry.service';
import { getLearnerAnalyticsRetentionState } from '../services/learner_analytics.service';
import { aggregateBackgroundJobHealth } from '../services/background_jobs_health.service';

export const managementRoutes: FastifyPluginAsync<{ db: Pool; redis: RedisService }> = async (
  app: FastifyInstance,
  opts: { db: Pool; redis: RedisService }
) => {
  const { db, redis } = opts;
  const audit = async (client: any, actor: any, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) => {
    await client.query(
      `INSERT INTO public.staff_audit_logs (actor_email, actor_role, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [actor.email, actor.role, action, entityType, entityId, JSON.stringify(metadata)]
    );
  };
  const containsDirectContact = (value: string) => /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(value) || /(?:\+?880|0)?1[3-9](?:[\s()-]*\d){8}/.test(value);

  const staffRoleSchema = z.enum(['super_admin', 'setter', 'moderator', 'scheduler', 'support']);
  app.get('/api/v1/management/staff',
    { preHandler: [requireStaffRole(['super_admin'])] }, async (_req, reply) => {
      try {
        const result = await db.query(`SELECT id, email, username, full_name AS "fullName", role, is_active AS "isActive", created_at AS "createdAt"
          FROM public.staff_members ORDER BY created_at DESC LIMIT 500`);
        return { staff: result.rows };
      } catch (err) {
        _req.log.error({ err }, 'Staff directory unavailable');
        return reply.status(503).send({ error: 'Staff directory unavailable; apply the staff directory migration first.' });
      }
    });

  app.post('/api/v1/management/staff',
    { preHandler: [requireStaffRole(['super_admin'])] }, async (req, reply) => {
      const body = z.object({
        email: z.string().trim().email().max(150),
        username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/),
        fullName: z.string().trim().min(2).max(100),
        role: staffRoleSchema,
        password: z.string().min(STAFF_PASSWORD_MIN_LENGTH).max(128),
      }).safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: body.error.errors[0].message });
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query(`INSERT INTO public.staff_members (email, username, password_hash, full_name, role, is_active, session_version)
          VALUES (lower($1), $2, $3, $4, $5, true, 1)
          RETURNING id, email, username, full_name AS "fullName", role, is_active AS "isActive", created_at AS "createdAt"`,
        [body.data.email, body.data.username, hashStaffPassword(body.data.password), body.data.fullName, body.data.role]);
        const created = inserted.rows[0];
        await audit(client, (req as any).staffUser, 'staff.account.created', 'staff_account', created.id,
          { email: created.email, username: created.username, role: created.role });
        await client.query('COMMIT');
        return reply.code(201).send({ staff: created });
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err.code === '23505') return reply.status(409).send({ error: 'A staff account already uses this email address or username.' });
        req.log.error({ err }, 'Staff account creation failed');
        return reply.status(503).send({ error: 'Unable to create this staff account.' });
      } finally { client.release(); }
    });

  app.post('/api/v1/management/staff/:id/update',
    { preHandler: [requireStaffRole(['super_admin'])] }, async (req, reply) => {
      const id = z.string().uuid().safeParse((req.params as any).id);
      if (!id.success) return reply.status(400).send({ error: 'Invalid staff account ID.' });
      const body = z.object({
        username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/).optional(),
        fullName: z.string().trim().min(2).max(100).optional(),
        role: staffRoleSchema.optional(),
        isActive: z.boolean().optional(),
      }).refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one account change.' }).safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: body.error.errors[0].message });
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(404, 1)');
        const found = await client.query(`SELECT id, email, username, full_name, role, is_active FROM public.staff_members WHERE id=$1::uuid FOR UPDATE`, [id.data]);
        if (!found.rowCount) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Staff account not found.' }); }
        const current = found.rows[0];
        const nextRole = body.data.role ?? current.role;
        const nextActive = body.data.isActive ?? current.is_active;
        const nextUsername = body.data.username ?? current.username;
        const privilegeChanged = nextRole !== current.role || nextActive !== current.is_active || nextUsername !== current.username;
        if (current.role === 'super_admin' && current.is_active && (nextRole !== 'super_admin' || !nextActive)) {
          const remaining = await client.query(`SELECT count(*)::int AS count FROM public.staff_members
            WHERE role='super_admin' AND is_active=true AND id<>$1::uuid`, [id.data]);
          if (remaining.rows[0].count < 1) {
            await client.query('ROLLBACK');
            return reply.status(409).send({ error: 'At least one active super-admin account must remain.' });
          }
        }
        const updated = await client.query(`UPDATE public.staff_members SET
            full_name=COALESCE($2::varchar, full_name), role=$3::varchar, is_active=$4::boolean, username=$5::varchar,
            session_version=session_version + CASE WHEN role IS DISTINCT FROM $3::varchar
              OR is_active IS DISTINCT FROM $4::boolean OR username IS DISTINCT FROM $5::varchar THEN 1 ELSE 0 END
          WHERE id=$1::uuid
          RETURNING id, email, username, full_name AS "fullName", role, is_active AS "isActive", created_at AS "createdAt"`,
        [id.data, body.data.fullName ?? null, nextRole, nextActive, nextUsername]);
        await audit(client, (req as any).staffUser, 'staff.account.updated', 'staff_account', id.data,
          { previousRole: current.role, role: nextRole, wasActive: current.is_active, isActive: nextActive, nameChanged: body.data.fullName !== undefined, usernameChanged: nextUsername !== current.username });
        await client.query('COMMIT');
        return { staff: updated.rows[0], requiresReauthentication: privilegeChanged };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err.code === '23505') return reply.status(409).send({ error: 'That staff username is already in use.' });
        req.log.error({ err }, 'Staff account update failed');
        return reply.status(503).send({ error: 'Unable to update this staff account.' });
      } finally { client.release(); }
    });

  app.post('/api/v1/management/staff/:id/reset-password',
    { preHandler: [requireStaffRole(['super_admin'])] }, async (req, reply) => {
      const id = z.string().uuid().safeParse((req.params as any).id);
      if (!id.success) return reply.status(400).send({ error: 'Invalid staff account ID.' });
      const body = z.object({ password: z.string().min(STAFF_PASSWORD_MIN_LENGTH).max(128) }).safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: body.error.errors[0].message });
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(`UPDATE public.staff_members SET password_hash=$2, session_version=session_version+1
          WHERE id=$1::uuid RETURNING id, email`, [id.data, hashStaffPassword(body.data.password)]);
        if (!result.rowCount) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Staff account not found.' }); }
        await audit(client, (req as any).staffUser, 'staff.password.reset', 'staff_account', id.data, { email: result.rows[0].email });
        await client.query('COMMIT');
        return { success: true, requiresReauthentication: true };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        req.log.error({ err }, 'Staff password reset failed');
        return reply.status(503).send({ error: 'Unable to reset this staff password.' });
      } finally { client.release(); }
    });

  app.get('/api/v1/management/questions/review-queue',
    { preHandler: [requireStaffRole(['moderator', 'super_admin'])] }, async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const status = String((req.query as any)?.status || 'under_review');
      if (!['draft', 'under_review', 'approved', 'rejected', 'archived'].includes(status)) return reply.status(400).send({ error: 'Invalid review status' });
      try {
        const params: unknown[] = [status];
        let where = 'q.review_status=$1';
        const query = req.query as any;
        for (const [key, column] of [['subjectId', 'q.subject_id'], ['topicId', 'q.topic_id']] as const) {
          if (query[key]) {
            if (!z.string().uuid().safeParse(query[key]).success) return reply.status(400).send({ error: `Invalid ${key}.` });
            params.push(query[key]);
            where += ` AND ${column}=$${params.length}::uuid`;
          }
        }
        if (query.institutionId) {
          if (!z.string().uuid().safeParse(query.institutionId).success) return reply.status(400).send({ error: 'Invalid institutionId.' });
          params.push(query.institutionId);
          where += ` AND q.target_university_id=$${params.length}::uuid`;
        }
        if (query.track && query.track !== 'all') {
          if (!['engineering', 'humanities', 'business', 'sciences', 'pharmacy', 'architecture', 'law'].includes(query.track)) return reply.status(400).send({ error: 'Invalid track.' });
          params.push(query.track);
          where += ` AND q.target_track=$${params.length}`;
        }
        if (query.language && query.language !== 'all') {
          if (!['bangla', 'english', 'mixed'].includes(query.language)) return reply.status(400).send({ error: 'Invalid language.' });
          params.push(query.language);
          where += ` AND q.language=$${params.length}`;
        }
        if (query.difficulty && query.difficulty !== 'all') {
          const difficulty = Number(query.difficulty);
          if (!Number.isFinite(difficulty) || difficulty < 0 || difficulty > 5) return reply.status(400).send({ error: 'Invalid difficulty.' });
          params.push(difficulty);
          where += ` AND ABS(q.difficulty_rating-$${params.length}::numeric)<0.5`;
        }
        if (typeof query.search === 'string' && query.search.trim()) {
          params.push(`%${query.search.trim().slice(0, 120)}%`);
          where += ` AND (q.stem_primary ILIKE $${params.length} OR q.id::text ILIKE $${params.length})`;
        }
        const result = await db.query(`SELECT q.id, q.subject_id AS "subjectId", s.name AS "subjectName", q.topic_id AS "topicId", t.name AS "topicName", q.target_university_id AS "targetUniversityId", u.short_name AS "targetUniversityName", q.target_track AS "targetTrack", q.language, q.stem_primary AS "questionText", q.options, q.solution_markdown AS explanation, q.difficulty_rating AS difficulty, q.review_status AS status, q.reviewed_by AS "reviewedBy", q.reviewed_at AS "reviewedAt", q.review_notes AS "reviewNotes", q.created_at AS "createdAt" FROM public.questions q LEFT JOIN public.academic_subjects s ON s.id=q.subject_id LEFT JOIN public.academic_topics t ON t.id=q.topic_id LEFT JOIN public.universities u ON u.id=q.target_university_id WHERE ${where} ORDER BY q.created_at ASC LIMIT 100`, params);
        return { success: true, count: result.rowCount, questions: result.rows };
      } catch (err) { req.log.error({ err }, 'Failed to load review queue'); return reply.status(503).send({ error: 'Review workflow is unavailable; apply the admin review migration first.' }); }
    });

  app.get('/api/v1/management/question-reports',
    { preHandler: [requireStaffRole(['moderator', 'super_admin'])] }, async (req, reply) => {
      const status = String((req.query as any)?.status || 'open');
      if (!['open', 'in_review', 'resolved', 'dismissed'].includes(status)) return reply.status(400).send({ error: 'Invalid report status.' });
      try {
        const result = await db.query(`SELECT r.id, r.question_id AS "questionId", q.stem_primary AS "questionText", s.name AS "subjectName", t.name AS "topicName", r.category, r.description, r.status, r.created_at AS "createdAt", r.resolution_note AS "resolutionNote", r.resolved_by AS "resolvedBy", r.resolved_at AS "resolvedAt" FROM public.question_reports r JOIN public.questions q ON q.id=r.question_id LEFT JOIN public.academic_subjects s ON s.id=q.subject_id LEFT JOIN public.academic_topics t ON t.id=q.topic_id WHERE r.status=$1 ORDER BY r.created_at ASC LIMIT 100`, [status]);
        return { reports: result.rows, count: result.rowCount };
      } catch (err) { req.log.error({ err }, 'Question report queue unavailable'); return reply.status(503).send({ error: 'Question report workflow is unavailable; apply the question reports migration first.' }); }
    });

  app.get('/api/v1/management/ai-response-reports',
    { preHandler: [requireStaffRole(['moderator', 'super_admin'])] }, async (req, reply) => {
      const status = String((req.query as any)?.status || 'open');
      if (!['open', 'in_review', 'resolved', 'dismissed'].includes(status)) return reply.status(400).send({ error: 'Invalid tutor report status.' });
      try {
        const [result, summaryResult, safetyActivityResult] = await Promise.all([db.query(`SELECT r.id, r.question_id AS "questionId",
            q.stem_primary AS "questionText", r.category, r.response_text AS "responseText",
            r.status, r.resolution_note AS "resolutionNote", r.resolved_by AS "resolvedBy",
            r.created_at AS "createdAt", r.resolved_at AS "resolvedAt",
            count(*) OVER() AS "totalCount"
          FROM public.ai_response_reports r
          LEFT JOIN public.questions q ON q.id=r.question_id
          WHERE r.status=$1 ORDER BY r.created_at ASC LIMIT 100`, [status]),
          db.query(`SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status='open')::int AS open,
              count(*) FILTER (WHERE status='in_review')::int AS "inReview",
              count(*) FILTER (WHERE status='resolved')::int AS resolved,
              count(*) FILTER (WHERE status='dismissed')::int AS dismissed,
              count(*) FILTER (WHERE category='incorrect')::int AS incorrect,
              count(*) FILTER (WHERE category='unsafe')::int AS unsafe,
              count(*) FILTER (WHERE category='irrelevant')::int AS irrelevant,
              count(*) FILTER (WHERE category='other')::int AS other
            FROM public.ai_response_reports`),
          db.query(`SELECT
              count(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS "currentUnsafeReports",
              count(DISTINCT reporter_id) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS "currentDistinctReporters",
              count(*) FILTER (WHERE created_at < now() - interval '24 hours' AND created_at >= now() - interval '48 hours')::int AS "previousUnsafeReports",
              count(DISTINCT reporter_id) FILTER (WHERE created_at < now() - interval '24 hours' AND created_at >= now() - interval '48 hours')::int AS "previousDistinctReporters",
              count(*) FILTER (WHERE status='open' AND created_at >= now() - interval '24 hours')::int AS "currentOpen",
              count(*) FILTER (WHERE status='in_review' AND created_at >= now() - interval '24 hours')::int AS "currentInReview",
              count(*) FILTER (WHERE status='resolved' AND created_at >= now() - interval '24 hours')::int AS "currentResolved",
              count(*) FILTER (WHERE status='dismissed' AND created_at >= now() - interval '24 hours')::int AS "currentDismissed"
            FROM public.ai_response_reports
            WHERE category='unsafe' AND created_at >= now() - interval '48 hours'`)]);
        const summary = Object.fromEntries(Object.entries(summaryResult.rows[0] || {}).map(([key, value]) => [key, Number(value || 0)]));
        const safetyActivity = Object.fromEntries(Object.entries(safetyActivityResult.rows[0] || {}).map(([key, value]) => [key, Number(value || 0)]));
        const safetyAlert = safetyActivity.currentUnsafeReports >= 3 && safetyActivity.currentDistinctReporters >= 2;
        return {
          reports: result.rows,
          count: Number(result.rows[0]?.totalCount || 0),
          summary,
          safetyTrend: {
            windowHours: 24,
            ...safetyActivity,
            thresholdReports: 3,
            thresholdReporters: 2,
            alertTriggered: safetyAlert,
            generatedAt: new Date().toISOString(),
          },
          generatedAt: new Date().toISOString(),
        };
      } catch (err) {
        req.log.error({ err }, 'AI tutor response report queue unavailable');
        return reply.status(503).send({ error: 'Tutor response report storage is unavailable; apply the AI response reports migration first.' });
      }
    });

  app.post('/api/v1/management/ai-response-reports/:id/review',
    { preHandler: [requireStaffRole(['moderator', 'super_admin'])] }, async (req, reply) => {
      const reportId = z.string().uuid().safeParse((req.params as any).id);
      if (!reportId.success) return reply.status(400).send({ error: 'Invalid tutor response report ID.' });
      const parsed = z.object({
        status: z.enum(['in_review', 'resolved', 'dismissed']),
        note: z.string().trim().max(1000).optional(),
      }).safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      if (parsed.data.status !== 'in_review' && !parsed.data.note?.trim()) return reply.status(400).send({ error: 'A resolution note is required.' });
      if (parsed.data.note && containsDirectContact(parsed.data.note)) return reply.status(400).send({ error: 'Do not include phone numbers or email addresses in moderator notes.' });
      const actor = (req as any).staffUser;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const currentResult = await client.query(`SELECT status FROM public.ai_response_reports WHERE id=$1::uuid FOR UPDATE`, [reportId.data]);
        const current = currentResult.rows[0]?.status;
        if (!current) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Tutor response report not found.' }); }
        const allowed: Record<string, string[]> = {
          open: ['in_review', 'resolved', 'dismissed'],
          in_review: ['resolved', 'dismissed'],
          resolved: [],
          dismissed: [],
        };
        if (!allowed[current]?.includes(parsed.data.status)) {
          await client.query('ROLLBACK');
          return reply.status(409).send({ error: `Cannot change a ${current} report to ${parsed.data.status}.` });
        }
        if (parsed.data.status === 'in_review') {
          await client.query(`UPDATE public.ai_response_reports SET status='in_review', updated_at=now() WHERE id=$1::uuid`, [reportId.data]);
        } else {
          await client.query(`UPDATE public.ai_response_reports SET status=$2, resolution_note=$3, resolved_by=$4, resolved_at=now(), updated_at=now() WHERE id=$1::uuid`, [reportId.data, parsed.data.status, parsed.data.note!.trim(), actor.email]);
        }
        await audit(client, actor, `ai_response.${parsed.data.status}`, 'ai_response_report', reportId.data, { status: parsed.data.status, note: parsed.data.note?.trim() || null });
        await client.query('COMMIT');
        return { success: true, id: reportId.data, status: parsed.data.status };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        req.log.error({ err }, 'AI tutor response report review failed');
        return reply.status(503).send({ error: 'Unable to review this tutor response report.' });
      } finally { client.release(); }
    });

  app.post('/api/v1/management/question-reports/:id/resolve',
    { preHandler: [requireStaffRole(['moderator', 'super_admin'])] }, async (req, reply) => {
      const body = z.object({ status: z.enum(['resolved', 'dismissed']), note: z.string().trim().min(3).max(1000) }).safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: body.error.errors[0].message });
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(`UPDATE public.question_reports SET status=$2, resolution_note=$3, resolved_by=$4, resolved_at=now(), updated_at=now() WHERE id=$1::uuid AND status IN ('open','in_review') RETURNING id, question_id`, [(req.params as any).id, body.data.status, body.data.note, (req as any).staffUser.email]);
        if (!result.rowCount) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Open report not found.' }); }
        await audit(client, (req as any).staffUser, `question_report.${body.data.status}`, 'question_report', result.rows[0].id, { questionId: result.rows[0].question_id, note: body.data.note });
        await client.query('COMMIT');
        return { success: true, id: result.rows[0].id, status: body.data.status };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err.code === '22P02') return reply.status(400).send({ error: 'Invalid report identifier.' });
        req.log.error({ err }, 'Question report resolution failed');
        return reply.status(503).send({ error: 'Unable to update this report.' });
      } finally { client.release(); }
    });

  app.post('/api/v1/management/questions/:id/review',
    { preHandler: [requireStaffRole(['moderator', 'super_admin'])] }, async (req, reply) => {
      const body = z.object({ decision: z.enum(['approved', 'rejected']), notes: z.string().trim().max(1000).optional() }).safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: body.error.errors[0].message });
      if (body.data.decision === 'rejected' && !body.data.notes?.trim()) return reply.status(400).send({ error: 'A reason is required when rejecting a question.' });
      const actor = (req as any).staffUser;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(`UPDATE public.questions SET review_status=$2, is_active=($2='approved'), reviewed_by=$3, reviewed_at=now(), review_notes=$4 WHERE id=$1::uuid AND review_status='under_review' RETURNING id`, [(req.params as any).id, body.data.decision, actor.email, body.data.notes || null]);
        if (!updated.rowCount) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Question is not awaiting review.' }); }
        await audit(client, actor, `question.${body.data.decision}`, 'question', updated.rows[0].id, { decision: body.data.decision, notes: body.data.notes || null });
        await client.query('COMMIT');
        return { success: true, id: updated.rows[0].id, status: body.data.decision };
      } catch (err) { await client.query('ROLLBACK').catch(() => undefined); req.log.error({ err }, 'Review decision failed'); return reply.status(503).send({ error: 'Review workflow is unavailable; apply the admin review migration first.' }); }
      finally { client.release(); }
    });

  app.get('/api/v1/management/coverage',
    { preHandler: [requireStaffRole(['setter', 'moderator', 'scheduler', 'super_admin'])] }, async (req, reply) => {
      const limit = Math.min(500, Math.max(25, Number((req.query as any)?.limit) || 250));
      try {
        const [topics, quality, examIntegrity] = await Promise.all([
          db.query(`WITH topic_counts AS (SELECT s.id AS "subjectId", s.name AS "subjectName", t.id AS "topicId", t.name AS "topicName", COUNT(q.id) FILTER (WHERE q.is_active=true AND q.review_status='approved')::int AS "approvedQuestions" FROM public.academic_topics t JOIN public.academic_subjects s ON s.id=t.subject_id LEFT JOIN public.questions q ON q.topic_id=t.id GROUP BY s.id, s.name, t.id, t.name) SELECT *, COUNT(*) OVER() AS "totalTopics", COUNT(*) FILTER (WHERE "approvedQuestions"=0) OVER() AS "totalZeroCoverage" FROM topic_counts ORDER BY "approvedQuestions" ASC, "subjectName", "topicName" LIMIT $1`, [limit]),
          db.query(`SELECT
              COUNT(*) FILTER (WHERE length(trim(COALESCE(stem_primary,'')))<5)::int AS "shortStems",
              COUNT(*) FILTER (WHERE length(trim(COALESCE(solution_markdown,'')))<3)::int AS "missingExplanations",
              COUNT(*) FILTER (WHERE CASE WHEN jsonb_typeof(options)='array'
                THEN jsonb_array_length(options)<2 OR (SELECT count(*) FROM jsonb_array_elements(options) AS option_item WHERE COALESCE(option_item->>'is_correct','false')='true')<>1
                ELSE true END)::int AS "invalidOptionSets",
              COUNT(*) FILTER (WHERE jsonb_typeof(options)='array'
                AND (SELECT count(*) FROM jsonb_array_elements(options) AS option_item WHERE COALESCE(option_item->>'is_correct','false')='true')>1)::int AS "multipleCorrectOptionSets"
            FROM public.questions WHERE is_active=true AND review_status='approved'`),
          db.query(`WITH exam_checks AS (
              SELECT e.id, e.title, e.track, e.starts_at, e.ends_at,
                count(eq.question_id)::int AS question_count,
                count(eq.question_id) FILTER (WHERE q.id IS NULL
                  OR q.is_active IS DISTINCT FROM true
                  OR q.review_status IS DISTINCT FROM 'approved'
                  OR q.topic_id IS NULL
                  OR length(trim(COALESCE(q.stem_primary,''))) < 5
                  OR length(trim(COALESCE(q.solution_markdown,''))) < 3
                  OR CASE WHEN jsonb_typeof(q.options)='array'
                    THEN jsonb_array_length(q.options) < 2
                      OR (SELECT count(*) FROM jsonb_array_elements(q.options) AS option_item
                        WHERE COALESCE(option_item->>'is_correct','false')='true') <> 1
                    ELSE true END)::int AS non_ready_question_links,
                COALESCE(array_agg(eq.question_id::text ORDER BY eq.question_order) FILTER (WHERE eq.question_id IS NOT NULL AND (q.id IS NULL
                  OR q.is_active IS DISTINCT FROM true
                  OR q.review_status IS DISTINCT FROM 'approved'
                  OR q.topic_id IS NULL
                  OR length(trim(COALESCE(q.stem_primary,''))) < 5
                  OR length(trim(COALESCE(q.solution_markdown,''))) < 3
                  OR CASE WHEN jsonb_typeof(q.options)='array'
                    THEN jsonb_array_length(q.options) < 2
                      OR (SELECT count(*) FROM jsonb_array_elements(q.options) AS option_item
                        WHERE COALESCE(option_item->>'is_correct','false')='true') <> 1
                    ELSE true END)), ARRAY[]::text[]) AS non_ready_question_ids
              FROM public.exams e
              LEFT JOIN public.exam_questions eq ON eq.exam_id=e.id
              LEFT JOIN public.questions q ON q.id=eq.question_id
              WHERE e.is_active=true AND e.is_draft=false
              GROUP BY e.id, e.title, e.track, e.starts_at, e.ends_at
            ), summary AS (
              SELECT count(*)::int AS "publishedExams",
                count(*) FILTER (WHERE question_count=0)::int AS "withoutQuestions",
                count(*) FILTER (WHERE question_count>200)::int AS "overQuestionLimit",
                count(*) FILTER (WHERE non_ready_question_links>0)::int AS "withNonReadyQuestions",
                COALESCE(sum(non_ready_question_links),0)::int AS "nonReadyQuestionLinks",
                count(*) FILTER (WHERE starts_at IS NOT NULL AND starts_at<=now()
                  AND (ends_at IS NULL OR ends_at>now()) AND non_ready_question_links>0)::int AS "inWindowWithNonReadyQuestions",
                COALESCE(sum(non_ready_question_links) FILTER (WHERE starts_at IS NOT NULL
                  AND starts_at<=now() AND (ends_at IS NULL OR ends_at>now())),0)::int AS "inWindowNonReadyQuestionLinks",
                count(*) FILTER (WHERE starts_at IS NULL)::int AS "missingStartTime",
                count(*) FILTER (WHERE ends_at IS NOT NULL AND starts_at IS NOT NULL AND ends_at<=starts_at)::int AS "invalidScheduleWindows",
                count(*) FILTER (WHERE starts_at IS NOT NULL AND starts_at<=now()
                  AND (ends_at IS NULL OR ends_at>now()))::int AS "withinScheduleWindow"
              FROM exam_checks
            ), issue_rows AS (
              SELECT id, title, track, starts_at, ends_at, question_count, non_ready_question_links,
                non_ready_question_ids,
                array_remove(ARRAY[
                  CASE WHEN question_count=0 THEN 'empty_exam' END,
                  CASE WHEN question_count>200 THEN 'over_question_limit' END,
                  CASE WHEN non_ready_question_links>0 THEN 'non_ready_question_links' END,
                  CASE WHEN starts_at IS NULL THEN 'missing_start_time' END,
                  CASE WHEN ends_at IS NOT NULL AND starts_at IS NOT NULL AND ends_at<=starts_at THEN 'invalid_schedule_window' END
                ], NULL) AS issue_reasons
              FROM exam_checks
              WHERE question_count=0 OR question_count>200 OR non_ready_question_links>0
                OR starts_at IS NULL OR (ends_at IS NOT NULL AND starts_at IS NOT NULL AND ends_at<=starts_at)
              ORDER BY (starts_at IS NOT NULL AND starts_at<=now() AND (ends_at IS NULL OR ends_at>now())) DESC,
                starts_at NULLS FIRST, id
              LIMIT 250
            ), issue_count AS (
              SELECT count(*)::int AS value FROM exam_checks
              WHERE question_count=0 OR question_count>200 OR non_ready_question_links>0
                OR starts_at IS NULL OR (ends_at IS NOT NULL AND starts_at IS NOT NULL AND ends_at<=starts_at)
            )
            SELECT summary.*, issue_count.value AS "issueCount",
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'examId', id, 'title', title, 'track', track, 'startsAt', starts_at, 'endsAt', ends_at,
                'questionCount', question_count, 'nonReadyQuestionLinks', non_ready_question_links,
                'nonReadyQuestionIds', non_ready_question_ids, 'reasons', issue_reasons
              )) FROM issue_rows), '[]'::jsonb) AS issues
            FROM summary CROSS JOIN issue_count`),
        ]);
        let performanceReview: { available: boolean; windowDays: number; minAnsweredAttempts: number; minLearners: number; accuracyThresholdPercent: number; flags: any[]; generatedAt: string };
        try {
          const review = await db.query(`WITH question_performance AS (
              SELECT q.id AS "questionId", s.name AS "subjectName",
                count(*) FILTER (WHERE a.outcome IN ('correct','wrong'))::int AS "answeredAttempts",
                count(*) FILTER (WHERE a.outcome='correct')::int AS "correctAttempts",
                count(DISTINCT es.user_id) FILTER (WHERE a.outcome IN ('correct','wrong'))::int AS "learnerCount"
              FROM public.exam_submission_answers a
              JOIN public.exam_submissions es ON es.id=a.submission_id
              JOIN public.questions q ON q.id=a.question_id
              LEFT JOIN public.academic_subjects s ON s.id=q.subject_id
              WHERE es.is_practice=false AND es.user_id IS NOT NULL
                AND es.submitted_at >= now() - interval '90 days'
                AND q.is_active=true AND q.review_status='approved'
              GROUP BY q.id, s.name
            )
            SELECT "questionId", "subjectName", "answeredAttempts", "correctAttempts", "learnerCount",
              round(100.0 * "correctAttempts" / NULLIF("answeredAttempts",0), 1)::float8 AS "accuracyPercent"
            FROM question_performance
            WHERE "answeredAttempts">=20 AND "learnerCount">=10
              AND 100.0 * "correctAttempts" / NULLIF("answeredAttempts",0) <= 40
            ORDER BY "accuracyPercent" ASC, "answeredAttempts" DESC
            LIMIT 50`);
          performanceReview = {
            available: true,
            windowDays: 90,
            minAnsweredAttempts: 20,
            minLearners: 10,
            accuracyThresholdPercent: 40,
            flags: review.rows,
            generatedAt: new Date().toISOString(),
          };
        } catch (err) {
          req.log.warn({ err }, 'Question performance review signals unavailable');
          performanceReview = {
            available: false,
            windowDays: 90,
            minAnsweredAttempts: 20,
            minLearners: 10,
            accuracyThresholdPercent: 40,
            flags: [],
            generatedAt: new Date().toISOString(),
          };
        }
        const rows = topics.rows;
        return { topics: rows.map(({ totalTopics: _total, totalZeroCoverage: _zero, ...topic }: any) => topic), totalTopics: Number(rows[0]?.totalTopics || 0), zeroCoverage: Number(rows[0]?.totalZeroCoverage || 0), qualitySignals: quality.rows[0], examIntegrity: examIntegrity.rows[0], performanceReview, generatedAt: new Date().toISOString(), limit };
      } catch (err) { req.log.error({ err }, 'Question coverage query failed'); return reply.status(500).send({ error: 'Unable to load content coverage.' }); }
    });

  app.get('/api/v1/management/support/learners/lookup',
    { preHandler: [requireStaffRole(['support', 'super_admin'])] }, async (req, reply) => {
      const raw = String((req.query as any)?.query || '').trim();
      if (raw.length < 7 || raw.length > 64) return reply.status(400).send({ error: 'Enter a complete learner phone number or user ID.' });
      const isUuid = z.string().uuid().safeParse(raw).success;
      const phoneDigits = raw.replace(/\D/g, '');
      if (!isUuid && (phoneDigits.length < 7 || phoneDigits.length > 16)) return reply.status(400).send({ error: 'Enter a complete learner phone number or user ID.' });
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(`SELECT u.id, u.full_name AS "fullName", right(regexp_replace(COALESCE(u.phone,''),'[^0-9]','','g'),4) AS "phoneLastFour", u.track, u.created_at AS "createdAt", u.total_xp AS "totalXp", (SELECT COUNT(*)::int FROM public.exam_submissions es WHERE es.user_id=u.id AND es.is_practice=false) AS "examSubmissions", (SELECT COUNT(*)::int FROM public.user_practice_progress p WHERE p.user_id=u.id) AS "topicsTracked", (SELECT round(avg(p.accuracy_rate)::numeric,1) FROM public.user_practice_progress p WHERE p.user_id=u.id) AS "averageTopicAccuracy", (SELECT max(activity_at) FROM (SELECT es.submitted_at AS activity_at FROM public.exam_submissions es WHERE es.user_id=u.id AND es.is_practice=false UNION ALL SELECT p.last_reviewed_at AS activity_at FROM public.user_practice_progress p WHERE p.user_id=u.id) activity) AS "lastObservedActivityAt" FROM public.users u WHERE ${isUuid ? 'u.id=$1::uuid' : "regexp_replace(COALESCE(u.phone,''),'[^0-9]','','g')=$1"} LIMIT 2`, [isUuid ? raw : phoneDigits]);
        if (result.rows.length > 1) {
          await audit(client, (req as any).staffUser, 'learner.lookup', 'learner', 'ambiguous', { result: 'ambiguous' });
          await client.query('COMMIT');
          return reply.status(409).send({ error: 'More than one account matches this phone number. Search with the user ID instead.' });
        }
        const learner = result.rows[0] || null;
        await audit(client, (req as any).staffUser, 'learner.lookup', 'learner', learner?.id || 'not_found', { result: learner ? 'found' : 'not_found' });
        await client.query('COMMIT');
        if (!learner) return reply.status(404).send({ error: 'No learner matched that phone number or user ID.' });
        return { learner: { ...learner, totalXp: Number(learner.totalXp) || 0, examSubmissions: Number(learner.examSubmissions) || 0, topicsTracked: Number(learner.topicsTracked) || 0, averageTopicAccuracy: learner.averageTopicAccuracy == null ? null : Number(learner.averageTopicAccuracy) } };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        req.log.error({ err }, 'Support learner lookup failed');
        return reply.status(500).send({ error: 'Learner lookup is temporarily unavailable.' });
      } finally { client.release(); }
    });

  app.get('/api/v1/management/support/cases',
    { preHandler: [requireStaffRole(['support', 'super_admin'])] }, async (req, reply) => {
      const status = String((req.query as any)?.status || 'open');
      if (!['all', 'open', 'in_progress', 'resolved', 'closed'].includes(status)) return reply.status(400).send({ error: 'Invalid support case status.' });
      const limit = Math.min(100, Math.max(1, Number((req.query as any)?.limit) || 50));
      const rawSearch = String((req.query as any)?.query || '').trim().toLowerCase();
      if (rawSearch && !z.string().uuid().safeParse(rawSearch).success) return reply.status(400).send({ error: 'Search with a complete case ID or learner ID.' });
      try {
        const result = await db.query(`WITH latest_status AS (
            SELECT DISTINCT ON (entity_id)
              entity_id AS case_id,
              metadata->>'status' AS status,
              metadata->>'note' AS note,
              actor_email,
              created_at
            FROM public.staff_audit_logs
            WHERE entity_type='support_case' AND action='support.case.status_changed'
            ORDER BY entity_id, id DESC
          )
          SELECT case_log.entity_id AS id,
            case_log.metadata->>'learnerId' AS "learnerId",
            case_log.metadata->>'category' AS category,
            case_log.metadata->>'summary' AS summary,
            COALESCE(latest.status, 'open') AS status,
            case_log.actor_email AS "createdBy",
            case_log.created_at AS "createdAt",
            latest.note AS "statusNote",
            latest.actor_email AS "statusChangedBy",
            latest.created_at AS "statusChangedAt",
            count(*) OVER() AS "totalCount"
          FROM public.staff_audit_logs case_log
          LEFT JOIN latest_status latest ON latest.case_id=case_log.entity_id
          WHERE case_log.entity_type='support_case'
            AND case_log.action='support.case.created'
            AND ($1='all' OR COALESCE(latest.status, 'open')=$1)
            AND ($3::text IS NULL OR case_log.entity_id=$3 OR case_log.metadata->>'learnerId'=$3)
          ORDER BY case_log.id DESC LIMIT $2`, [status, limit, rawSearch || null]);
        let supportRequests: any[] = [];
        let supportRequestsAvailable = true;
        try {
          const requestResult = await db.query(`SELECT id, requester_id AS "learnerId", category,
              subject, message, status, staff_note AS "statusNote", updated_by AS "statusChangedBy",
              created_at AS "createdAt", updated_at AS "statusChangedAt",
              count(*) OVER() AS "totalCount"
            FROM public.learner_support_requests
            WHERE ($1='all' OR status=$1)
              AND ($2::text IS NULL OR id::text=$2 OR requester_id::text=$2)
            ORDER BY created_at DESC LIMIT $3`, [status, rawSearch || null, limit]);
          supportRequests = requestResult.rows;
        } catch (err: any) {
          if (err.code === '42P01') supportRequestsAvailable = false;
          else throw err;
        }
        return { cases: result.rows, count: Number(result.rows[0]?.totalCount || 0), supportRequests, supportRequestsCount: Number(supportRequests[0]?.totalCount || 0), supportRequestsAvailable };
      } catch (err) {
        req.log.error({ err }, 'Support case queue unavailable');
        return reply.status(503).send({ error: 'Support case queue is unavailable.' });
      }
    });

  app.post('/api/v1/management/support/requests/:id/status',
    { preHandler: [requireStaffRole(['support', 'super_admin'])] }, async (req, reply) => {
      const requestId = z.string().uuid().safeParse((req.params as any).id);
      if (!requestId.success) return reply.status(400).send({ error: 'Invalid support request ID.' });
      const parsed = z.object({
        status: z.enum(['in_progress', 'resolved', 'closed']),
        note: z.string().trim().min(3).max(1000).refine((value) => !containsDirectContact(value), 'Do not include phone numbers or email addresses in staff notes.'),
      }).safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      const actor = (req as any).staffUser;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const currentResult = await client.query(`SELECT status FROM public.learner_support_requests WHERE id=$1::uuid FOR UPDATE`, [requestId.data]);
        const current = currentResult.rows[0]?.status;
        if (!current) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Support request not found.' }); }
        const allowed: Record<string, string[]> = {
          open: ['in_progress', 'resolved'],
          in_progress: ['resolved'],
          resolved: ['in_progress', 'closed'],
          closed: [],
        };
        if (!allowed[current]?.includes(parsed.data.status)) {
          await client.query('ROLLBACK');
          return reply.status(409).send({ error: `Cannot change a ${current} request to ${parsed.data.status}.` });
        }
        await client.query(`UPDATE public.learner_support_requests
          SET status=$2, staff_note=$3, updated_by=$4, updated_at=now(),
              resolved_at=CASE WHEN $2='resolved' THEN now() WHEN $2='in_progress' THEN NULL ELSE resolved_at END
          WHERE id=$1::uuid`, [requestId.data, parsed.data.status, parsed.data.note, actor.email]);
        await audit(client, actor, 'support.request.status_changed', 'support_request', requestId.data, { status: parsed.data.status, note: parsed.data.note });
        await client.query('COMMIT');
        return { success: true, id: requestId.data, status: parsed.data.status };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        req.log.error({ err }, 'Learner support request status update failed');
        return reply.status(503).send({ error: 'Unable to update the learner support request.' });
      } finally { client.release(); }
    });

  app.post('/api/v1/management/support/cases',
    { preHandler: [requireStaffRole(['support', 'super_admin'])] }, async (req, reply) => {
      const parsed = z.object({
        learnerId: z.string().uuid(),
        category: z.enum(['account_access', 'profile_update', 'learning_progress', 'exam_access', 'other']),
        summary: z.string().trim().min(5).max(1000).refine((value) => !containsDirectContact(value), 'Do not include phone numbers or email addresses in the case summary.'),
      }).safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      const caseId = randomUUID();
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const learner = await client.query('SELECT id FROM public.users WHERE id=$1::uuid FOR KEY SHARE', [parsed.data.learnerId]);
        if (!learner.rowCount) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Learner not found.' }); }
        await audit(client, (req as any).staffUser, 'support.case.created', 'support_case', caseId, {
          learnerId: parsed.data.learnerId,
          category: parsed.data.category,
          summary: parsed.data.summary,
          status: 'open',
        });
        await client.query('COMMIT');
        return reply.code(201).send({ success: true, id: caseId, status: 'open' });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        req.log.error({ err }, 'Support case creation failed');
        return reply.status(503).send({ error: 'Unable to create the support case.' });
      } finally { client.release(); }
    });

  app.post('/api/v1/management/support/cases/:id/status',
    { preHandler: [requireStaffRole(['support', 'super_admin'])] }, async (req, reply) => {
      const caseId = z.string().uuid().safeParse((req.params as any).id);
      if (!caseId.success) return reply.status(400).send({ error: 'Invalid support case ID.' });
      const parsed = z.object({
        status: z.enum(['in_progress', 'resolved', 'closed']),
        note: z.string().trim().min(3).max(1000).refine((value) => !containsDirectContact(value), 'Do not include phone numbers or email addresses in case notes.'),
      }).safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [40404, caseId.data]);
        const original = await client.query(`SELECT entity_id FROM public.staff_audit_logs WHERE entity_type='support_case' AND action='support.case.created' AND entity_id=$1`, [caseId.data]);
        if (!original.rowCount) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Support case not found.' }); }
        const latest = await client.query(`SELECT metadata->>'status' AS status FROM public.staff_audit_logs WHERE entity_type='support_case' AND action='support.case.status_changed' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [caseId.data]);
        const current = latest.rows[0]?.status || 'open';
        const allowed: Record<string, string[]> = {
          open: ['in_progress', 'resolved'],
          in_progress: ['resolved'],
          resolved: ['in_progress', 'closed'],
          closed: [],
        };
        if (!allowed[current]?.includes(parsed.data.status)) {
          await client.query('ROLLBACK');
          return reply.status(409).send({ error: `Cannot change a ${current} case to ${parsed.data.status}.` });
        }
        await audit(client, (req as any).staffUser, 'support.case.status_changed', 'support_case', caseId.data, parsed.data);
        await client.query('COMMIT');
        return { success: true, id: caseId.data, status: parsed.data.status };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        req.log.error({ err }, 'Support case status update failed');
        return reply.status(503).send({ error: 'Unable to update the support case.' });
      } finally { client.release(); }
    });

  app.get('/api/v1/management/analytics/learning',
    { preHandler: [requireStaffRole(['setter', 'moderator', 'scheduler', 'super_admin'])] }, async (req, reply) => {
      const raw = Number((req.query as any)?.days || 30);
      const days = [7, 30, 90].includes(raw) ? raw : 30;
      try {
        const [result, profileResult, signupTrackResult, examTrackResult, learningOutcomeResult, progressResult] = await Promise.all([
          db.query(`WITH calendar AS (
              SELECT day::date AS day,
                CASE WHEN day::date >= current_date-($1::int-1) THEN 'current' ELSE 'previous' END AS period
              FROM generate_series(current_date-(($1::int*2)-1), current_date, interval '1 day') day
            ), signups AS (
              SELECT created_at::date AS day, count(*)::int AS signups
              FROM public.users
              WHERE created_at >= current_date-(($1::int*2)-1)
                AND created_at < current_date+1
              GROUP BY created_at::date
            ), submissions AS (
              SELECT submitted_at::date AS day, count(*)::int AS exam_submissions
              FROM public.exam_submissions
              WHERE is_practice=false
                AND submitted_at >= current_date-(($1::int*2)-1)
                AND submitted_at < current_date+1
              GROUP BY submitted_at::date
            ), verified_practice AS (
              SELECT created_at::date AS day,
                count(*)::int AS attempts,
                count(DISTINCT user_id)::int AS learners,
                count(*) FILTER (WHERE is_correct)::int AS correct_attempts
              FROM public.practice_attempts
              WHERE created_at >= current_date-(($1::int*2)-1)
                AND created_at < current_date+1
              GROUP BY created_at::date
            ), practice AS (
              SELECT last_reviewed_at::date AS day,
                count(DISTINCT user_id)::int AS observed_practice_learners,
                round(avg(accuracy_rate)::numeric,1) AS avg_topic_accuracy
              FROM public.user_practice_progress
              WHERE user_id IS NOT NULL
                AND last_reviewed_at >= current_date-(($1::int*2)-1)
                AND last_reviewed_at < current_date+1
              GROUP BY last_reviewed_at::date
            ), activity_sources AS (
              SELECT user_id, submitted_at::date AS day
              FROM public.exam_submissions
              WHERE is_practice=false
                AND user_id IS NOT NULL
                AND submitted_at >= current_date-(($1::int*2)-1)
                AND submitted_at < current_date+1
              UNION
              SELECT user_id, last_reviewed_at::date AS day
              FROM public.user_practice_progress
              WHERE user_id IS NOT NULL
                AND last_reviewed_at >= current_date-(($1::int*2)-1)
                AND last_reviewed_at < current_date+1
            ), observed_learners AS (
              SELECT day, count(*)::int AS recorded_account_ids
              FROM activity_sources
              GROUP BY day
            )
            SELECT calendar.day, calendar.period,
              COALESCE(signups.signups,0) AS signups,
              COALESCE(submissions.exam_submissions,0) AS exam_submissions,
              COALESCE(verified_practice.attempts,0) AS verified_practice_attempts,
              COALESCE(verified_practice.learners,0) AS verified_practice_learners,
              verified_practice.correct_attempts AS verified_practice_correct,
              COALESCE(practice.observed_practice_learners,0) AS observed_practice_learners,
              COALESCE(observed_learners.recorded_account_ids,0) AS recorded_account_ids,
              practice.avg_topic_accuracy
            FROM calendar
            LEFT JOIN signups USING(day)
            LEFT JOIN submissions USING(day)
            LEFT JOIN verified_practice USING(day)
            LEFT JOIN practice USING(day)
            LEFT JOIN observed_learners USING(day)
            ORDER BY calendar.day`, [days]),
          db.query(`SELECT count(*)::int AS "eligibleAccounts",
              count(*) FILTER (WHERE medium IN ('bangla','english')
                AND NULLIF(trim(academic_batch),'') IS NOT NULL
                AND NULLIF(trim(institution_name),'') IS NOT NULL
                AND CASE WHEN jsonb_typeof(target_universities)='array'
                  THEN jsonb_array_length(target_universities)>0 ELSE false END)::int AS "profilesComplete"
            FROM public.users`),
          db.query(`SELECT COALESCE(NULLIF(trim(track),''),'Unspecified') AS track,
              count(*)::int AS count
            FROM public.users
            WHERE created_at >= current_date-($1::int-1) AND created_at < current_date+1
            GROUP BY 1 ORDER BY count DESC`, [days]),
          db.query(`SELECT COALESCE(NULLIF(trim(e.track),''),'Unspecified') AS track,
              count(*)::int AS count
            FROM public.exam_submissions s
            LEFT JOIN public.exams e ON e.id=s.exam_id
            WHERE s.is_practice=false
              AND s.submitted_at >= current_date-($1::int-1) AND s.submitted_at < current_date+1
            GROUP BY 1 ORDER BY count DESC`, [days]),
          db.query(`SELECT COALESCE(NULLIF(trim(e.track),''),'Unspecified') AS track,
              count(*)::int AS submissions,
              sum(s.correct_count)::int AS "correctAttempts",
              sum(s.wrong_count)::int AS "wrongAttempts",
              sum(s.unanswered_count)::int AS "skippedAttempts",
              (sum(s.correct_count)+sum(s.wrong_count))::int AS "answeredAttempts",
              round(100.0*sum(s.correct_count)
                / NULLIF(sum(s.correct_count)+sum(s.wrong_count),0),1) AS "accuracyPercent"
            FROM public.exam_submissions s
            LEFT JOIN public.exams e ON e.id=s.exam_id
            WHERE s.is_practice=false
              AND s.submitted_at >= current_date-($1::int-1)
              AND s.submitted_at < current_date+1
            GROUP BY 1
            HAVING sum(s.correct_count)+sum(s.wrong_count) >= 5
            ORDER BY "answeredAttempts" DESC, track
            LIMIT 50`, [days]),
          db.query(`SELECT CASE
                WHEN last_reviewed_at >= current_date-($1::int-1) THEN 'current'
                ELSE 'previous'
              END AS period,
              count(*)::int AS "topicUpdates",
              count(DISTINCT user_id)::int AS learners,
              round(avg(accuracy_rate)::numeric,1) AS "averageAccuracy"
            FROM public.user_practice_progress
            WHERE user_id IS NOT NULL
              AND last_reviewed_at >= current_date-(($1::int*2)-1)
              AND last_reviewed_at < current_date+1
            GROUP BY 1`, [days]),
        ]);
        const [practiceTotalsResult, practiceTopicsResult] = await Promise.all([
          db.query(`SELECT CASE WHEN created_at >= current_date-($1::int-1) THEN 'current' ELSE 'previous' END AS period,
              count(*)::int AS attempts, count(DISTINCT user_id)::int AS learners,
              count(*) FILTER (WHERE is_correct)::int AS correct_attempts,
              count(*) FILTER (WHERE NOT is_correct)::int AS wrong_attempts
            FROM public.practice_attempts
            WHERE created_at >= current_date-(($1::int*2)-1) AND created_at < current_date+1
            GROUP BY 1`, [days]),
          db.query(`SELECT a.subject_id AS "subjectId", a.topic_id AS "topicId",
              COALESCE(s.name,'Uncategorized') AS "subjectName", COALESCE(t.name,'Uncategorized') AS "topicName",
              count(*)::int AS attempts, count(DISTINCT a.user_id)::int AS learners,
              count(*) FILTER (WHERE a.is_correct)::int AS "correctAttempts",
              count(*) FILTER (WHERE NOT a.is_correct)::int AS "wrongAttempts",
              round(100.0*count(*) FILTER (WHERE a.is_correct)/NULLIF(count(*),0),1) AS "accuracyPercent"
            FROM public.practice_attempts a
            LEFT JOIN public.academic_subjects s ON s.id=a.subject_id
            LEFT JOIN public.academic_topics t ON t.id=a.topic_id
            WHERE a.created_at >= current_date-($1::int-1) AND a.created_at < current_date+1
            GROUP BY a.subject_id,a.topic_id,s.name,t.name
            HAVING count(*) >= 5 AND count(DISTINCT a.user_id) >= 5
            ORDER BY "accuracyPercent" ASC, attempts DESC LIMIT 30`, [days]),
        ]);
        let topicOutcomeResult: { rows: any[] } = { rows: [] };
        try {
          topicOutcomeResult = await db.query(`SELECT a.subject_id AS "subjectId", a.topic_id AS "topicId",
              COALESCE(s.name, 'Uncategorized') AS "subjectName",
              COALESCE(t.name, 'Uncategorized') AS "topicName",
              count(*) FILTER (WHERE a.outcome IN ('correct','wrong'))::int AS "answeredAttempts",
              count(*) FILTER (WHERE a.outcome='correct')::int AS "correctAttempts",
              count(*) FILTER (WHERE a.outcome='wrong')::int AS "wrongAttempts",
              count(*) FILTER (WHERE a.outcome='skipped')::int AS "skippedAttempts",
              round(100.0*count(*) FILTER (WHERE a.outcome='correct')
                / NULLIF(count(*) FILTER (WHERE a.outcome IN ('correct','wrong')),0),1) AS "accuracyPercent"
            FROM public.exam_submission_answers a
            JOIN public.exam_submissions sub ON sub.id=a.submission_id
            LEFT JOIN public.academic_subjects s ON s.id=a.subject_id
            LEFT JOIN public.academic_topics t ON t.id=a.topic_id
            WHERE sub.is_practice=false
              AND sub.submitted_at >= current_date-($1::int-1)
              AND sub.submitted_at < current_date+1
            GROUP BY a.subject_id, a.topic_id, s.name, t.name
            HAVING count(*) FILTER (WHERE a.outcome IN ('correct','wrong')) >= 5
              AND count(DISTINCT sub.user_id) >= 5
            ORDER BY "accuracyPercent" ASC, "answeredAttempts" DESC
            LIMIT 30`, [days]);
        } catch (err: any) {
          if (err?.code !== '42P01') throw err;
          req.log.warn('Per-question analytics migration is not applied yet');
        }
        let matchedTopicGains: any[] = [];
        try {
          const gains = await db.query(`WITH learner_topic_period AS (
              SELECT a.topic_id,s.user_id,
                CASE WHEN s.submitted_at >= current_date-($1::int-1) THEN 'current' ELSE 'previous' END AS period,
                count(*)::int AS answered_attempts,
                count(*) FILTER (WHERE a.outcome='correct')::int AS correct_attempts
              FROM public.exam_submission_answers a
              JOIN public.exam_submissions s ON s.id=a.submission_id
              WHERE s.is_practice=false
                AND s.user_id IS NOT NULL
                AND s.submitted_at >= current_date-(($1::int*2)-1)
                AND s.submitted_at < current_date+1
                AND a.topic_id IS NOT NULL AND a.outcome IN ('correct','wrong')
              GROUP BY a.topic_id,s.user_id,period
              HAVING count(*) >= 5
            ), paired_learner_topic AS (
              SELECT topic_id,user_id,
                count(*) FILTER (WHERE period='previous')::int AS previous_periods,
                count(*) FILTER (WHERE period='current')::int AS current_periods,
                100.0*max(correct_attempts) FILTER (WHERE period='previous')
                  / NULLIF(max(answered_attempts) FILTER (WHERE period='previous'),0) AS previous_accuracy,
                100.0*max(correct_attempts) FILTER (WHERE period='current')
                  / NULLIF(max(answered_attempts) FILTER (WHERE period='current'),0) AS current_accuracy
              FROM learner_topic_period
              GROUP BY topic_id,user_id
              HAVING count(*) FILTER (WHERE period='previous')=1
                AND count(*) FILTER (WHERE period='current')=1
            )
            SELECT p.topic_id AS "topicId",COALESCE(t.name,'Uncategorized') AS "topicName",
              COALESCE(s.name,'Uncategorized') AS "subjectName",count(*)::int AS "matchedLearners",
              round(avg(p.previous_accuracy)::numeric,1) AS "previousAccuracy",
              round(avg(p.current_accuracy)::numeric,1) AS "currentAccuracy",
              round(avg(p.current_accuracy-p.previous_accuracy)::numeric,1) AS "averageChangePoints"
            FROM paired_learner_topic p
            LEFT JOIN public.academic_topics t ON t.id=p.topic_id
            LEFT JOIN public.academic_subjects s ON s.id=t.subject_id
            GROUP BY p.topic_id,t.name,s.name
            HAVING count(*) >= 5
            ORDER BY "averageChangePoints" ASC,"matchedLearners" DESC
            LIMIT 30`, [days]);
          matchedTopicGains = gains.rows.map((row: any) => ({ topicId: row.topicId, topicName: row.topicName, subjectName: row.subjectName, matchedLearners: Number(row.matchedLearners), previousAccuracy: Number(row.previousAccuracy), currentAccuracy: Number(row.currentAccuracy), averageChangePoints: Number(row.averageChangePoints) }));
        } catch (err: any) {
          if (err?.code !== '42P01') throw err;
          req.log.warn('Matched topic progress requires the exam outcome snapshot migration');
        }
        let battleMetricsAvailable = true;
        let battleMetricsResult: { rows: any[] } = { rows: [] };
        try {
          battleMetricsResult = await db.query(`SELECT CASE
                WHEN created_at >= current_date-($1::int-1) THEN 'current'
                ELSE 'previous'
              END AS period,
              count(*)::int AS started,
              count(*) FILTER (WHERE status='finished')::int AS completed,
              count(*) FILTER (WHERE status='in_progress')::int AS underway
            FROM public.battle_rooms
            WHERE cardinality(player_ids)=2
              AND player_ids[1] <> player_ids[2]
              AND created_at >= current_date-(($1::int*2)-1)
              AND created_at < current_date+1
            GROUP BY 1`, [days]);
        } catch (err: any) {
          if (err?.code !== '42P01' && err?.code !== '42703') throw err;
          battleMetricsAvailable = false;
          req.log.warn('Battle analytics schema is not available yet');
        }
        const rows = result.rows.map((r: any) => {
          const practiceLearners = Number(r.verified_practice_learners || 0);
          return { date: r.day, period: r.period, signups: Number(r.signups), examSubmissions: Number(r.exam_submissions), verifiedPracticeAttempts: practiceLearners >= 5 ? Number(r.verified_practice_attempts) : null, verifiedPracticeAccuracy: practiceLearners >= 5 && Number(r.verified_practice_attempts) ? Number((Number(r.verified_practice_correct) / Number(r.verified_practice_attempts) * 100).toFixed(1)) : null, observedPracticeLearners: Number(r.observed_practice_learners), recordedAccountIds: Number(r.recorded_account_ids), averageRecordedTopicAccuracy: r.avg_topic_accuracy == null ? null : Number(r.avg_topic_accuracy) };
        });
        const sum = (period: string) => rows.filter((r: any) => r.period === period).reduce((a: any, r: any) => ({ signups: a.signups+r.signups, examSubmissions: a.examSubmissions+r.examSubmissions }), { signups: 0, examSubmissions: 0 });
        const current = sum('current');
        const previous = sum('previous');
        const progressByPeriod = Object.fromEntries(progressResult.rows.map((row: any) => [row.period, row]));
        const visibleProgress = (row: any) => row && Number(row.learners) >= 5 && row.averageAccuracy != null
          ? { learners: Number(row.learners), topicUpdates: Number(row.topicUpdates), averageAccuracy: Number(row.averageAccuracy) }
          : null;
        const currentProgress = visibleProgress(progressByPeriod.current);
        const previousProgress = visibleProgress(progressByPeriod.previous);
        const progressChangePoints = currentProgress && previousProgress
          ? Number((currentProgress.averageAccuracy - previousProgress.averageAccuracy).toFixed(1))
          : null;
        const battleByPeriod = Object.fromEntries(battleMetricsResult.rows.map((row: any) => [row.period, row]));
        const battlePeriod = (row: any) => ({
          started: Number(row?.started || 0),
          completed: Number(row?.completed || 0),
          underway: Number(row?.underway || 0),
        });
        const currentBattles = battlePeriod(battleByPeriod.current);
        const previousBattles = battlePeriod(battleByPeriod.previous);
        const battleChangePercent = previousBattles.started
          ? Number((((currentBattles.started-previousBattles.started)/previousBattles.started)*100).toFixed(1))
          : null;
        const change = (key: 'signups' | 'examSubmissions') => previous[key] ? Number((((current[key]-previous[key])/previous[key])*100).toFixed(1)) : null;
        const eligibleAccounts = Number(profileResult.rows[0]?.eligibleAccounts || 0);
        const profilesComplete = Number(profileResult.rows[0]?.profilesComplete || 0);
        let consentedAnalytics: any = { available: false, policy: 'Explicit opt-in; 12-month event retention; withdrawal deletes prior events.', minimumLearners: 5 };
        try {
          const eventMetrics = await db.query(`WITH first_open AS (
              SELECT user_id, min(event_day) AS cohort_day
              FROM public.learner_analytics_events WHERE event_name='app_open'
              GROUP BY user_id
            ), cohort_sizes AS (
              SELECT count(*) FILTER (WHERE cohort_day <= current_date-1)::int AS mature1,
                     count(*) FILTER (WHERE cohort_day <= current_date-30)::int AS mature30,
                     count(*) FILTER (WHERE cohort_day <= current_date-7)::int AS mature7,
                     count(*)::int AS observed
              FROM first_open
            ), returns AS (
              SELECT count(DISTINCT f.user_id) FILTER (WHERE f.cohort_day<=current_date-1 AND e.event_day=f.cohort_day+1)::int AS d1,
                     count(DISTINCT f.user_id) FILTER (WHERE f.cohort_day<=current_date-7 AND e.event_day BETWEEN f.cohort_day+1 AND f.cohort_day+7)::int AS d7,
                     count(DISTINCT f.user_id) FILTER (WHERE f.cohort_day<=current_date-30 AND e.event_day BETWEEN f.cohort_day+1 AND f.cohort_day+30)::int AS d30
              FROM first_open f JOIN public.learner_analytics_events e
                ON e.user_id=f.user_id AND e.event_name='app_open'
               AND e.event_day BETWEEN f.cohort_day+1 AND f.cohort_day+30
            ), event_counts AS (
              SELECT event_name, count(*)::int AS events, count(DISTINCT user_id)::int AS learners
              FROM public.learner_analytics_events
              WHERE occurred_at >= current_date-($1::int-1) AND occurred_at < current_date+1
              GROUP BY event_name
            ), consent_count AS (
              SELECT count(*)::int AS enabled
              FROM public.users u
              WHERE NOT EXISTS (
                SELECT 1 FROM public.learner_analytics_consent c
                WHERE c.user_id = u.id AND c.enabled = false
              )
            ), consented_cohort AS (
              SELECT user_id,min(occurred_at) AS granted_at
              FROM public.learner_analytics_events
              WHERE event_name='analytics_consent_granted'
                AND occurred_at >= current_date-($1::int-1) AND occurred_at < current_date+1
              GROUP BY user_id
            ), ordered_funnel AS (
              SELECT c.user_id,
                onboarding.occurred_at AS onboarding_at,
                practice.occurred_at AS practice_at,
                exam.occurred_at AS exam_at
              FROM consented_cohort c
              LEFT JOIN LATERAL (
                SELECT min(occurred_at) AS occurred_at FROM public.learner_analytics_events
                WHERE user_id=c.user_id AND event_name='onboarding_completed' AND occurred_at>=c.granted_at
              ) onboarding ON true
              LEFT JOIN LATERAL (
                SELECT min(occurred_at) AS occurred_at FROM public.learner_analytics_events
                WHERE user_id=c.user_id AND event_name='practice_attempted'
                  AND onboarding.occurred_at IS NOT NULL AND occurred_at>=onboarding.occurred_at
              ) practice ON true
              LEFT JOIN LATERAL (
                SELECT min(occurred_at) AS occurred_at FROM public.learner_analytics_events
                WHERE user_id=c.user_id AND event_name='exam_submitted'
                  AND practice.occurred_at IS NOT NULL AND occurred_at>=practice.occurred_at
              ) exam ON true
            ), funnel_counts AS (
              SELECT count(*)::int AS entered,
                count(*) FILTER (WHERE onboarding_at IS NOT NULL)::int AS onboarded,
                count(*) FILTER (WHERE practice_at IS NOT NULL)::int AS practiced,
                count(*) FILTER (WHERE exam_at IS NOT NULL)::int AS examined
              FROM ordered_funnel
            ), daily_counts AS (
              SELECT event_day, count(DISTINCT user_id)::int AS learners
              FROM public.learner_analytics_events
              WHERE event_name='app_open'
                AND event_day >= current_date-($1::int-1) AND event_day <= current_date
              GROUP BY event_day
            ), daily_active AS (
              SELECT COALESCE(jsonb_agg(jsonb_build_object(
                  'date', calendar.day::text,
                  'learners', CASE WHEN COALESCE(daily_counts.learners,0)>=5 THEN daily_counts.learners ELSE NULL END
                ) ORDER BY calendar.day), '[]'::jsonb) AS rows
              FROM generate_series(current_date-($1::int-1), current_date, interval '1 day') AS calendar(day)
              LEFT JOIN daily_counts ON daily_counts.event_day=calendar.day::date
            ), streak_events AS (
              SELECT user_id,event_day,
                event_day-row_number() OVER (PARTITION BY user_id ORDER BY event_day)::int AS streak_group
              FROM public.learner_analytics_events
              WHERE event_name='app_open'
                AND event_day >= current_date-($1::int-1) AND event_day <= current_date
            ), streak_runs AS (
              SELECT user_id,streak_group,count(*)::int AS run_days
              FROM streak_events GROUP BY user_id,streak_group
            ), longest_streak AS (
              SELECT user_id,max(run_days)::int AS run_days
              FROM streak_runs GROUP BY user_id
            )
            SELECT (SELECT enabled FROM consent_count) AS enabled,
              (SELECT observed FROM cohort_sizes) AS observed,
              (SELECT mature7 FROM cohort_sizes) AS mature7,
              (SELECT mature1 FROM cohort_sizes) AS mature1,
              (SELECT mature30 FROM cohort_sizes) AS mature30,
              (SELECT d1 FROM returns) AS d1, (SELECT d7 FROM returns) AS d7, (SELECT d30 FROM returns) AS d30,
              (SELECT count(DISTINCT user_id)::int FROM public.learner_analytics_events WHERE event_name='app_open' AND event_day=current_date) AS dau,
              (SELECT count(DISTINCT user_id)::int FROM public.learner_analytics_events WHERE event_name='app_open' AND event_day>=current_date-6 AND event_day<=current_date) AS wau,
              (SELECT count(DISTINCT user_id)::int FROM public.learner_analytics_events WHERE event_name='app_open' AND event_day>=current_date-29 AND event_day<=current_date) AS mau,
              (SELECT rows FROM daily_active) AS daily_active,
              (SELECT count(*)::int FROM longest_streak WHERE run_days>=3) AS three_day_streak,
              (SELECT count(*)::int FROM longest_streak WHERE run_days>=7) AS seven_day_streak,
              (SELECT entered FROM funnel_counts) AS funnel_entered,
              (SELECT onboarded FROM funnel_counts) AS funnel_onboarded,
              (SELECT practiced FROM funnel_counts) AS funnel_practiced,
              (SELECT examined FROM funnel_counts) AS funnel_examined,
              COALESCE((SELECT jsonb_object_agg(event_name, jsonb_build_object('events',events,'learners',learners)) FROM event_counts WHERE learners>=5), '{}'::jsonb) AS events`, [days]);
          const metric = eventMetrics.rows[0];
          const mature1 = Number(metric.mature1 || 0), mature7 = Number(metric.mature7 || 0), mature30 = Number(metric.mature30 || 0);
          const d1Returners = Number(metric.d1 || 0), d7Returners = Number(metric.d7 || 0), d30Returners = Number(metric.d30 || 0);
          const activeLearners = { dau: Number(metric.dau || 0), wau: Number(metric.wau || 0), mau: Number(metric.mau || 0) };
          const enabled = Number(metric.enabled || 0);
          const funnelEntered = Number(metric.funnel_entered || 0);
          const funnelOnboarded = Number(metric.funnel_onboarded || 0);
          const funnelPracticed = Number(metric.funnel_practiced || 0);
          const funnelExamined = Number(metric.funnel_examined || 0);
          const practiceEvent = metric.events?.practice_attempted;
          const practiceEventLearners = Number(practiceEvent?.learners || 0);
          const practiceEventCount = Number(practiceEvent?.events || 0);
          consentedAnalytics = {
            available: true, enabledLearners: enabled >= 5 ? enabled : null,
            eventCounts: metric.events, observedAppOpenLearners: Number(metric.observed || 0) >= 5 ? Number(metric.observed) : null,
            practiceFrequency: {
              learners: practiceEventLearners >= 5 ? practiceEventLearners : null,
              attempts: practiceEventLearners >= 5 ? practiceEventCount : null,
              averageAttemptsPerLearner: practiceEventLearners >= 5 ? Number((practiceEventCount / practiceEventLearners).toFixed(1)) : null,
              minimumLearners: 5,
            },
            funnel: {
              available: true,
              cohortLearners: funnelEntered >= 5 ? funnelEntered : null,
              onboardingLearners: funnelOnboarded >= 5 ? funnelOnboarded : null,
              practiceLearners: funnelPracticed >= 5 ? funnelPracticed : null,
              examLearners: funnelExamined >= 5 ? funnelExamined : null,
              onboardingPercent: funnelEntered >= 5 && funnelOnboarded >= 5 ? Number((funnelOnboarded / funnelEntered * 100).toFixed(1)) : null,
              practicePercent: funnelEntered >= 5 && funnelPracticed >= 5 ? Number((funnelPracticed / funnelEntered * 100).toFixed(1)) : null,
              examPercent: funnelEntered >= 5 && funnelExamined >= 5 ? Number((funnelExamined / funnelEntered * 100).toFixed(1)) : null,
              minimumLearners: 5,
            },
            activeLearners: Object.fromEntries(Object.entries(activeLearners).map(([window, learners]) => [window, learners >= 5 ? learners : null])),
            dailyActive: (metric.daily_active || []).map((day: any) => ({ date: day.date, learners: day.learners == null ? null : Number(day.learners) })),
            appOpenStreaks: {
              threeDayLearners: Number(metric.three_day_streak || 0) >= 5 ? Number(metric.three_day_streak) : null,
              sevenDayLearners: Number(metric.seven_day_streak || 0) >= 5 ? Number(metric.seven_day_streak) : null,
              minimumLearners: 5,
            },
            retention: {
              d1: mature1 >= 5 && d1Returners >= 5 ? d1Returners : null,
              d1Cohort: mature1 >= 5 ? mature1 : null,
              d7: mature7 >= 5 && d7Returners >= 5 ? d7Returners : null,
              d30: mature30 >= 5 && d30Returners >= 5 ? d30Returners : null,
              d7Cohort: mature7 >= 5 ? mature7 : null,
              d30Cohort: mature30 >= 5 ? mature30 : null,
            }, minimumLearners: 5,
            definition: 'DAU is today’s distinct consented app-open learners; WAU and MAU are rolling 7-day and 30-day distinct learners. The daily chart and consecutive app-open streaks follow the selected 7/30/90-day window; they are app-open activity, not study streaks. Return rates use each consented learner’s first retained app-open day as cohort day. D1 is next-day return; D7/D30 are any return within those windows. Funnel cohorts begin at an explicit consent grant during the selected window; later stages count only when they occur in order after that grant. Counts and stage numerators below five learners are suppressed.',
          };
        } catch (err: any) {
          if (err?.code !== '42P01') throw err;
          req.log.warn('Consent-based analytics migration is not applied yet');
        }
        const privacyBoundGroups = (input: any[]) => {
          const visible: Array<{ track: string; count: number }> = [];
          let smallGroupCount = 0;
          for (const row of input) {
            const count = Number(row.count || 0);
            if (count < 5) smallGroupCount += count;
            else visible.push({ track: String(row.track), count });
          }
          if (smallGroupCount >= 5) visible.push({ track: 'Small groups', count: smallGroupCount });
          return visible;
        };
        consentedAnalytics.clientSegments = { available: false, minimumLearners: 5 };
        if (consentedAnalytics.available) {
          try {
            const [devices, versions, locales] = await Promise.all([
              db.query(`SELECT COALESCE(device_type,'unknown') AS track,count(DISTINCT user_id)::int AS count
                FROM public.learner_analytics_events WHERE event_name='app_open'
                  AND event_day >= current_date-($1::int-1) AND event_day <= current_date GROUP BY 1`, [days]),
              db.query(`SELECT COALESCE(app_version,'unknown') AS track,count(DISTINCT user_id)::int AS count
                FROM public.learner_analytics_events WHERE event_name='app_open'
                  AND event_day >= current_date-($1::int-1) AND event_day <= current_date GROUP BY 1`, [days]),
              db.query(`SELECT COALESCE(locale,'unknown') AS track,count(DISTINCT user_id)::int AS count
                FROM public.learner_analytics_events WHERE event_name='app_open'
                  AND event_day >= current_date-($1::int-1) AND event_day <= current_date GROUP BY 1`, [days]),
            ]);
            consentedAnalytics.clientSegments = {
              available: true,
              deviceTypes: privacyBoundGroups(devices.rows),
              appVersions: privacyBoundGroups(versions.rows),
              locales: privacyBoundGroups(locales.rows),
              minimumLearners: 5,
              definition: 'Distinct consented learners with an app-open event in the selected window. Each learner contributes at most once per UTC day; client context is first-party, validated, and may be unknown for older events or clients that omit it.',
            };
          } catch (error) {
            req.log.warn({ err: error }, 'Optional learner client segmentation is unavailable');
          }
        }
        const visiblePractice = (row: any) => row && Number(row.learners) >= 5 ? { attempts: Number(row.attempts), learners: Number(row.learners), correctAttempts: Number(row.correct_attempts), wrongAttempts: Number(row.wrong_attempts), accuracyPercent: Number(row.attempts) ? Number((Number(row.correct_attempts)/Number(row.attempts)*100).toFixed(1)) : null } : null;
        const practiceByPeriod = Object.fromEntries(practiceTotalsResult.rows.map((row: any) => [row.period,row]));
        return { days, generatedAt: new Date().toISOString(), consentedAnalytics, caveat: 'Recorded account IDs count distinct user IDs represented by a saved topic-progress update or non-practice exam submission that day. This is not DAU, verified session activity, or retention; historical IDs and saved topic-progress writes predate the current exam identity check. Server-scored practice attempts are counted separately and require five distinct learners for visible aggregates. Human duel counts represent distinct persisted two-player battle rooms, not connected sessions or unique daily learners. Practice learners are observed latest topic-progress updates, not event-based DAU or retention. Consent-based events are optional, begin only after opt-in, have no pre-consent backfill, are retained for at most 12 months, and are deleted on withdrawal. The onboarding profile metric is a current snapshot using required profile fields, not a signup-to-completion funnel. Track breakdowns count signup records and non-practice exam submissions in the selected window; categories below five records are combined and the combined row is suppressed when its total remains below five. Exam outcomes are aggregated from server-scored non-practice submission counts by exam track; accuracy uses correct/(correct+wrong), skips are reported separately, and groups with fewer than five answered attempts are suppressed. Question accuracy is based on durable server-scored per-question snapshots; topic rows require five answered attempts and five distinct learners. The observed topic-progress accuracy is an average of stored user-topic rates for rows updated in each period, is thresholded at five distinct learners, and is not a paired or longitudinal learning gain. Percentage change is omitted where the prior-period baseline is zero.', onboardingProfileSnapshot: { eligibleAccounts, profilesComplete, profilesIncomplete: Math.max(0, eligibleAccounts-profilesComplete), completionPercent: eligibleAccounts ? Number((profilesComplete/eligibleAccounts*100).toFixed(1)) : null, definition: 'Profile marked complete when medium, academic batch, institution name, and at least one target university are present.' }, signupTracks: privacyBoundGroups(signupTrackResult.rows), examSubmissionTracks: privacyBoundGroups(examTrackResult.rows), learningOutcomes: learningOutcomeResult.rows.map((r: any) => ({ track: r.track, submissions: Number(r.submissions), correctAttempts: Number(r.correctAttempts), wrongAttempts: Number(r.wrongAttempts), answeredAttempts: Number(r.answeredAttempts), skippedAttempts: Number(r.skippedAttempts), accuracyPercent: Number(r.accuracyPercent) })), topicOutcomes: topicOutcomeResult.rows.map((r: any) => ({ subjectId: r.subjectId, topicId: r.topicId, subjectName: r.subjectName, topicName: r.topicName, answeredAttempts: Number(r.answeredAttempts), correctAttempts: Number(r.correctAttempts), wrongAttempts: Number(r.wrongAttempts), skippedAttempts: Number(r.skippedAttempts), accuracyPercent: Number(r.accuracyPercent) })), practiceOutcomes: practiceTopicsResult.rows.map((r: any) => ({ subjectId:r.subjectId,topicId:r.topicId,subjectName:r.subjectName,topicName:r.topicName,attempts:Number(r.attempts),learners:Number(r.learners),correctAttempts:Number(r.correctAttempts),wrongAttempts:Number(r.wrongAttempts),accuracyPercent:Number(r.accuracyPercent) })), practiceTotals: { current: visiblePractice(practiceByPeriod.current), previous: visiblePractice(practiceByPeriod.previous), minimumLearners: 5 }, observedTopicProgress: { current: currentProgress, previous: previousProgress, changePoints: progressChangePoints, minimumLearners: 5 }, matchedTopicGains, humanBattles: { available: battleMetricsAvailable, current: currentBattles, previous: previousBattles, changePercent: battleChangePercent }, totals: { current, previous, changePercent: { signups: change('signups'), examSubmissions: change('examSubmissions') } }, daily: rows.filter((r: any) => r.period === 'current') };
      } catch (err) { req.log.error({ err }, 'Learning analytics query failed'); return reply.status(503).send({ error: 'Learning analytics unavailable for the current database schema.' }); }
    });

  app.get('/api/v1/management/audit-log',
    { preHandler: [requireStaffRole(['super_admin'])] }, async (req, reply) => {
      const limit = Math.min(100, Math.max(1, Number((req.query as any)?.limit) || 50));
      try { const result = await db.query(`SELECT id, actor_email AS "actorEmail", actor_role AS "actorRole", action, entity_type AS "entityType", entity_id AS "entityId", metadata, created_at AS "createdAt" FROM public.staff_audit_logs ORDER BY id DESC LIMIT $1`, [limit]); return { entries: result.rows }; }
      catch (err) { req.log.error({ err }, 'Audit log unavailable'); return reply.status(503).send({ error: 'Audit log unavailable; apply the admin review migration first.' }); }
    });

  app.get('/api/v1/management/health',
    { preHandler: [requireStaffRole(['super_admin'])] }, async (_req, reply) => {
      const requiredSubmissionColumns = ['exam_id', 'user_id', 'answers', 'score', 'correct_count', 'wrong_count', 'unanswered_count', 'time_taken_seconds', 'rank', 'idempotency_key', 'is_practice', 'candidate_name', 'candidate_institution', 'university_code', 'submitted_at'];
      let database: 'healthy' | 'unavailable' = 'unavailable';
      let databaseLatencyMs: number | null = null;
      let submissionStorage: 'ready' | 'unavailable' = 'unavailable';
      let missingSubmissionColumns: string[] | null = null;
      let idempotencyIndex: boolean | null = null;
      try {
        const startedAt = Date.now();
        await db.query('SELECT 1');
        databaseLatencyMs = Date.now() - startedAt;
        database = 'healthy';
        const [columns, index] = await Promise.all([
          db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='exam_submissions'`),
          db.query(`SELECT to_regclass('public.idx_exam_submissions_idempotency_key') IS NOT NULL AS available`),
        ]);
        const availableColumns = new Set(columns.rows.map((row: any) => row.column_name));
        missingSubmissionColumns = requiredSubmissionColumns.filter((column) => !availableColumns.has(column));
        idempotencyIndex = Boolean(index.rows[0]?.available);
        submissionStorage = missingSubmissionColumns.length === 0 ? 'ready' : 'unavailable';
      } catch (err) {
        _req.log.warn({ err }, 'Health dependency probe failed');
      }
      const redisHealth = await redis.checkHealth();
      const redisStatus = redisHealth.status;
      const candidateIdentityVerification = process.env.SUPABASE_URL && (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY)
        ? 'configured'
        : 'not_configured';
      const pipelineStatus = database !== 'healthy' || submissionStorage !== 'ready'
        ? 'unavailable'
        : redisStatus === 'healthy' && idempotencyIndex === true && candidateIdentityVerification === 'configured' ? 'ready' : 'degraded';
      const retentionJob = getExamSessionRetentionState();
      const learnerAnalyticsRetentionJob = getLearnerAnalyticsRetentionState();
      const backgroundJobsStatus = aggregateBackgroundJobHealth([retentionJob.status, learnerAnalyticsRetentionJob.status]);
      let aiTutorUsage: any = { available: false, provider: 'none', mode: 'deterministic_hint_prototype' };
      try {
        const [usageResult, feedbackResult] = await Promise.all([
          db.query(`SELECT COALESCE(sum(request_count),0)::bigint AS requests,
              COALESCE(sum(success_count),0)::bigint AS successes,
              COALESCE(sum(no_hint_count),0)::bigint AS no_hints,
              COALESCE(sum(not_found_count),0)::bigint AS not_found,
              COALESCE(sum(failure_count),0)::bigint AS failures,
              COALESCE(sum(rate_limited_count),0)::bigint AS rate_limited,
              COALESCE(sum(invalid_request_count),0)::bigint AS invalid_requests,
              COALESCE(sum(latency_total_ms),0)::bigint AS latency_total,
              COALESCE(max(latency_max_ms),0)::int AS latency_max,
              COALESCE(sum(provider_cost_microusd),0)::bigint AS provider_cost_microusd
            FROM public.ai_tutor_usage_daily WHERE event_day>=current_date-29`),
          db.query(`SELECT count(*)::int AS reports FROM public.ai_response_reports WHERE created_at>=now()-INTERVAL '30 days'`),
        ]);
        const row = usageResult.rows[0];
        const requests = Number(row.requests || 0);
        const rateLimited = Number(row.rate_limited || 0);
        const invalidRequests = Number(row.invalid_requests || 0);
        const accepted = Math.max(0, requests-rateLimited-invalidRequests);
        const failures = Number(row.failures || 0)+Number(row.not_found || 0);
        aiTutorUsage = {
          available: true,
          windowDays: 30,
          provider: 'none',
          mode: 'deterministic_hint_prototype',
          requests,
          successes: Number(row.successes || 0),
          noHints: Number(row.no_hints || 0),
          notFound: Number(row.not_found || 0),
          failures: Number(row.failures || 0),
          rateLimited,
          invalidRequests,
          failureRatePercent: accepted ? Number((failures/accepted*100).toFixed(1)) : null,
          averageLatencyMs: requests ? Number((Number(row.latency_total)/requests).toFixed(1)) : null,
          maxLatencyMs: Number(row.latency_max || 0),
          providerCostUsd: Number(row.provider_cost_microusd || 0)/1_000_000,
          feedbackReports: Number(feedbackResult.rows[0]?.reports || 0),
          retentionMonths: 12,
        };
      } catch (err) {
        _req.log.warn({ err }, 'AI tutor usage metrics are unavailable');
      }
      const overallStatus = pipelineStatus === 'ready' && backgroundJobsStatus === 'healthy' ? 'operational' : 'degraded';
      return reply.code(database === 'healthy' ? 200 : 503).send({
        status: overallStatus,
        checkedAt: new Date().toISOString(),
        services: {
          api: 'reachable',
          database,
          redis: redisStatus,
          candidateIdentityVerification,
          examSubmissionStorage: submissionStorage,
          liveExamRanking: redisStatus,
          backgroundJobs: backgroundJobsStatus,
        },
        submissionReadiness: {
          status: pipelineStatus,
          mode: 'read_only_dependency_probe',
          databaseLatencyMs,
          redisLatencyMs: redisHealth.latencyMs,
          missingColumns: missingSubmissionColumns,
          idempotencyIndex: idempotencyIndex === null ? 'not_checked' : idempotencyIndex ? 'available' : 'missing',
          note: 'Checks database connectivity, submission schema, idempotency index, identity-verifier configuration, and performs Redis PING checks on the command, publisher, and subscriber connections. It does not contact Supabase Auth or submit a test exam.',
        },
        aiTutor: { configured: false, mode: 'deterministic_hint_prototype', usageMetricsAvailable: aiTutorUsage.available },
        aiTutorUsage,
        retentionJob: { ...retentionJob, schedule: 'every_6_hours', retentionDays: 30 },
        learnerAnalyticsRetentionJob: { ...learnerAnalyticsRetentionJob, schedule: 'every_6_hours', retentionMonths: 12 },
        databasePool: { total: db.totalCount, idle: db.idleCount, waiting: db.waitingCount },
      });
    });

  app.get('/api/v1/management/exam-incidents',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] }, async (req, reply) => {
      const limit = Math.min(100, Math.max(1, Number((req.query as any)?.limit) || 50));
      const status = String((req.query as any)?.status || 'all');
      if (!['all', 'open', 'acknowledged', 'resolved'].includes(status)) return reply.status(400).send({ error: 'Invalid incident status.' });
      try {
        const result = await db.query(`WITH latest_status AS (
            SELECT DISTINCT ON (metadata->>'incidentLogId')
              metadata->>'incidentLogId' AS incident_log_id,
              metadata->>'status' AS status,
              metadata->>'note' AS note,
              actor_email,
              created_at
            FROM public.staff_audit_logs
            WHERE action='exam.incident.status_changed'
            ORDER BY metadata->>'incidentLogId', id DESC
          )
          SELECT incident.id, incident.entity_id AS "examId", incident.metadata,
            incident.actor_email AS "reportedBy", incident.created_at AS "reportedAt",
            COALESCE(latest.status, 'open') AS status,
            latest.note AS "statusNote",
            latest.actor_email AS "statusChangedBy",
            latest.created_at AS "statusChangedAt"
          FROM public.staff_audit_logs incident
          LEFT JOIN latest_status latest ON latest.incident_log_id=incident.id::text
          WHERE incident.action='exam.incident.reported'
            AND ($2='all' OR COALESCE(latest.status, 'open')=$2)
          ORDER BY incident.id DESC LIMIT $1`, [limit, status]);
        let signals: Array<{ examId: string; examTitle: string; starts: number; failureAttempts: number; failureAttemptsPerStart: number }> = [];
        let signalsAvailable = false;
        try {
          const detected = await db.query(`SELECT e.id AS "examId", e.title AS "examTitle",
              COUNT(t.session_hash)::int AS starts, COALESCE(SUM(t.failure_count), 0)::int AS "failureAttempts"
            FROM public.exams e LEFT JOIN public.exam_session_telemetry t
              ON t.exam_id=e.id AND t.started_at >= now()-INTERVAL '15 minutes'
            WHERE e.is_active=true AND (e.starts_at IS NULL OR e.starts_at<=now())
              AND (e.ends_at IS NULL OR e.ends_at>now())
            GROUP BY e.id, e.title`);
          signals = detected.rows.map((row) => ({
            examId: row.examId, examTitle: row.examTitle, starts: Number(row.starts),
            failureAttempts: Number(row.failureAttempts),
            failureAttemptsPerStart: Number(row.starts) ? Number(row.failureAttempts) / Number(row.starts) : 0,
          })).filter((row) => row.starts >= 10 && row.failureAttempts >= 3 && row.failureAttemptsPerStart >= 0.2);
          signalsAvailable = true;
        } catch (err) { req.log.warn({ err }, 'Automated exam session signal query unavailable'); }
        return { incidents: result.rows, detectedSignals: signals, signalsAvailable };
      } catch (err) { req.log.error({ err }, 'Exam incident list unavailable'); return reply.status(500).send({ error: 'Unable to load exam incidents.' }); }
    });

  app.post('/api/v1/management/exam-incidents/:id/status',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] }, async (req, reply) => {
      const incidentId = String((req.params as any).id || '');
      if (!/^[1-9][0-9]*$/.test(incidentId)) return reply.status(400).send({ error: 'Invalid incident ID.' });
      const body = z.object({
        status: z.enum(['acknowledged', 'resolved']),
        note: z.string().trim().min(3).max(1000),
      }).safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: body.error.errors[0].message });
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [incidentId]);
        const incident = await client.query(`SELECT id, entity_id FROM public.staff_audit_logs WHERE id=$1 AND action='exam.incident.reported'`, [incidentId]);
        if (!incident.rowCount) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Incident not found.' }); }
        const latest = await client.query(`SELECT metadata->>'status' AS status FROM public.staff_audit_logs WHERE action='exam.incident.status_changed' AND metadata->>'incidentLogId'=$1 ORDER BY id DESC LIMIT 1`, [incidentId]);
        const currentStatus = latest.rows[0]?.status || 'open';
        if (currentStatus === 'resolved') { await client.query('ROLLBACK'); return reply.status(409).send({ error: 'Resolved incidents cannot be changed.' }); }
        if (currentStatus === body.data.status) { await client.query('ROLLBACK'); return reply.status(409).send({ error: `Incident is already ${currentStatus}.` }); }
        await audit(client, (req as any).staffUser, 'exam.incident.status_changed', 'exam_incident', incident.rows[0].entity_id, { incidentLogId: incidentId, status: body.data.status, note: body.data.note });
        await client.query('COMMIT');
        return { success: true, status: body.data.status };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        req.log.error({ err }, 'Exam incident status update failed');
        return reply.status(500).send({ error: 'Unable to update incident status.' });
      } finally { client.release(); }
    });

  app.post('/api/v1/management/exams/:slug/incidents',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] }, async (req, reply) => {
      const body = z.object({
        severity: z.enum(['info', 'minor', 'major', 'critical']),
        category: z.enum(['access', 'submission', 'content', 'scoring', 'other']),
        summary: z.string().trim().min(5).max(1000),
      }).safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: body.error.errors[0].message });
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const exam = await client.query(`SELECT id FROM public.exams WHERE id=$1::uuid`, [(req.params as any).slug]);
        if (!exam.rowCount) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Exam not found.' }); }
        await audit(client, (req as any).staffUser, 'exam.incident.reported', 'exam_incident', exam.rows[0].id, body.data);
        await client.query('COMMIT');
        return reply.code(201).send({ success: true });
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err.code === '22P02') return reply.status(400).send({ error: 'Invalid exam identifier.' });
        req.log.error({ err }, 'Exam incident write failed');
        return reply.status(500).send({ error: 'Unable to record exam incident.' });
      } finally { client.release(); }
    });

  // The following modular domains have been extracted:
  // - Blueprints & section generation: blueprint_management.routes.ts
  // - Questions & exam deployment: question_management.routes.ts
};
