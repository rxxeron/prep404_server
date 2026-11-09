import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import crypto from 'crypto';
import { RedisService } from '../redis/redis.service';
import { sendInternalError } from '../services/http_errors';
import { verifySupabaseAccessToken } from '../services/supabase_auth.service';

export const questionRoutes: FastifyPluginAsync<{ db: Pool; redis: RedisService }> = async (
  app: FastifyInstance,
  opts: { db: Pool; redis: RedisService }
) => {
  const { db, redis } = opts;

  // Dynamic Question Bank Endpoint (Strictly queries Supabase PostgreSQL and Redis)
  app.get('/api/v1/questions', async (
    req: FastifyRequest<{ Querystring: { subjectId?: string; topicId?: string; targetUni?: string; limit?: string; random?: string } }>,
    reply: FastifyReply
  ) => {
    const { subjectId, topicId, limit = '20', random } = req.query;
    const maxLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    if (!db) {
      return reply.status(503).send({ error: 'PostgreSQL database service unavailable' });
    }

    try {
      let query = `
        SELECT 
          q.id,
          q.item_type AS "itemType",
          q.subject_id AS "subjectId",
          s.name AS "subjectName",
          s.slug AS "subjectSlug",
          q.topic_id AS "topicId",
          t.name AS "topicName",
          q.stem_primary AS "questionText",
          (q.stem_primary LIKE '%$%' OR q.stem_primary LIKE '%\\%') AS "hasMath",
          q.options,
          q.difficulty_rating AS "difficultyRating",
          q.context_snippet AS "contextSnippet",
          qs.content_text AS "passage",
          qs.title AS "passageTitle",
          q.created_at AS "createdAt"
        FROM questions q
        LEFT JOIN academic_subjects s ON s.id = q.subject_id
        LEFT JOIN academic_topics t ON t.id = q.topic_id
        LEFT JOIN question_stimuli qs ON (qs.id = q.stimulus_id OR qs.external_slug = q.stimulus_id::text)
        WHERE q.is_active = true
          AND q.review_status = 'approved'
      `;
      const params: any[] = [];

      if (subjectId) {
        params.push(subjectId);
        query += ` AND (q.subject_id = $${params.length}::uuid OR s.slug = $${params.length})`;
      }
      if (topicId) {
        params.push(topicId);
        query += ` AND (q.topic_id = $${params.length}::uuid OR t.slug = $${params.length})`;
      }

      if (random === 'true' || random === '1') {
        const seed = crypto.randomUUID();
        params.push(seed);
        params.push(maxLimit);
        query += ` ORDER BY (q.id >= $${params.length - 1}::uuid) DESC, q.id ASC LIMIT $${params.length}`;
      } else {
        params.push(maxLimit);
        query += ` ORDER BY q.created_at DESC LIMIT $${params.length}`;
      }

      const result = await db.query(query, params);

      // Format options to include standard format
      const formatted = result.rows.map((row) => {
        let options = Array.isArray(row.options) ? row.options : [];
        const mappedOptions = options.map((opt: any, idx: number) => {
          const optKey = opt.key_original || String.fromCharCode(65 + idx);
          return {
            id: optKey,
            text: opt.text || '',
          };
        });

        return {
          id: row.id,
          itemType: row.itemType,
          subjectId: row.subjectId,
          subjectName: row.subjectName,
          subjectSlug: row.subjectSlug,
          topicId: row.topicId,
          topicName: row.topicName,
          questionText: row.questionText,
          hasMath: row.hasMath,
          options: mappedOptions,
          difficultyRating: parseFloat(row.difficultyRating || '1.0'),
          createdAt: row.createdAt,
        };
      });

      return {
        success: true,
        count: formatted.length,
        questions: formatted,
      };
    } catch (err: any) {
      req.log.error(err, 'Database query failed in questions endpoint');
      return sendInternalError(reply, err);
    }
  });

  // Get question subjects and topics dynamically from DB
  app.get('/api/v1/curriculum/subjects', async (_req, reply: FastifyReply) => {
    if (!db) {
      return reply.status(503).send({ error: 'Database service unavailable' });
    }

    try {
      const res = await db.query(`
        SELECT 
          s.id,
          s.slug,
          s.name,
          s.display_order AS "displayOrder",
          COALESCE(
            json_agg(
              json_build_object(
                'id', t.id,
                'slug', t.slug,
                'name', t.name
              ) ORDER BY t.name
            ) FILTER (WHERE t.id IS NOT NULL), '[]'
          ) AS topics
        FROM academic_subjects s
        LEFT JOIN academic_topics t ON t.subject_id = s.id
        GROUP BY s.id
        ORDER BY s.display_order ASC;
      `);

      return {
        success: true,
        count: res.rows.length,
        subjects: res.rows,
      };
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // Learner Question Reports API
  app.get('/api/v1/user/question-reports', async (req: FastifyRequest, reply: FastifyReply) => {
    let userId = (req.query as any)?.userId;
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!userId && token) {
      try {
        userId = (await verifySupabaseAccessToken(token)).id;
      } catch (_) {}
    }

    if (!userId) {
      return reply.status(401).send({ success: false, error: 'Sign in to view your question reports.' });
    }

    try {
      const result = await db.query(`
        SELECT 
          r.id,
          r.question_id AS "questionId",
          q.stem_primary AS "questionText",
          s.name AS "subjectName",
          t.name AS "topicName",
          r.category,
          r.description,
          r.status,
          r.created_at AS "createdAt",
          r.resolution_note AS "resolutionNote",
          r.resolved_by AS "resolvedBy",
          r.resolved_at AS "resolvedAt"
        FROM public.question_reports r
        JOIN public.questions q ON q.id = r.question_id
        LEFT JOIN public.academic_subjects s ON s.id = q.subject_id
        LEFT JOIN public.academic_topics t ON t.id = q.topic_id
        WHERE r.reporter_id = $1::uuid
        ORDER BY r.created_at DESC
        LIMIT 100
      `, [userId]);

      return {
        success: true,
        count: result.rowCount,
        reports: result.rows,
      };
    } catch (err: any) {
      req.log.error(err, 'Failed to fetch learner question reports');
      return sendInternalError(reply, err);
    }
  });

  app.post('/api/v1/user/question-reports', async (req: FastifyRequest, reply: FastifyReply) => {
    let userId = (req.body as any)?.userId;
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!userId && token) {
      try {
        userId = (await verifySupabaseAccessToken(token)).id;
      } catch (_) {}
    }

    if (!userId) {
      return reply.status(401).send({ success: false, error: 'Sign in to report a question.' });
    }

    const { questionId, category, description } = (req.body as any) || {};
    if (!questionId || !category || !description) {
      return reply.status(400).send({ success: false, error: 'questionId, category, and description are required.' });
    }

    if (typeof description !== 'string' || description.trim().length < 5 || description.trim().length > 500) {
      return reply.status(400).send({ success: false, error: 'Description must be between 5 and 500 characters.' });
    }

    try {
      const result = await db.query(`
        INSERT INTO public.question_reports (question_id, reporter_id, category, description, status)
        VALUES ($1::uuid, $2::uuid, $3, $4, 'open')
        RETURNING id, question_id AS "questionId", category, description, status, created_at AS "createdAt"
      `, [questionId, userId, category, description.trim()]);

      return {
        success: true,
        report: result.rows[0],
      };
    } catch (err: any) {
      req.log.error(err, 'Failed to submit learner question report');
      return sendInternalError(reply, err);
    }
  });
};
