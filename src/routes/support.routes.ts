import { createHash, randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { RedisService } from '../redis/redis.service';
import { SupabaseAuthVerificationError, verifySupabaseAccessToken } from '../services/supabase_auth.service';

const contactPattern = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+?880|0)?1[3-9](?:[\s()-]*\d){8}/;

export const supportRoutes: FastifyPluginAsync<{ db: Pool; redis: RedisService }> = async (app: FastifyInstance, opts) => {
  const { db, redis } = opts;

  const resolveUser = async (req: any, reply: any): Promise<string | null> => {
    const match = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      reply.status(401).send({ error: 'Sign in to contact learner support.' });
      return null;
    }
    try {
      return (await verifySupabaseAccessToken(match[1])).id;
    } catch (err) {
      const statusCode = err instanceof SupabaseAuthVerificationError ? err.statusCode : 503;
      const message = statusCode === 401 ? 'Your sign-in has expired. Sign in again.' : 'Sign-in verification is temporarily unavailable.';
      reply.status(statusCode).send({ error: message });
      return null;
    }
  };

  app.get('/api/v1/support/requests', async (req, reply) => {
    const requesterId = await resolveUser(req, reply);
    if (!requesterId) return;
    try {
      const result = await db.query(`SELECT id, category, subject, message, status,
          staff_note AS "staffNote", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM public.learner_support_requests WHERE requester_id=$1::uuid
        ORDER BY created_at DESC LIMIT 50`, [requesterId]);
      return { requests: result.rows };
    } catch (err) {
      req.log.error({ err }, 'Learner support request history unavailable');
      return reply.status(503).send({ error: 'Support request history is unavailable.' });
    }
  });

  app.post('/api/v1/support/requests', async (req, reply) => {
    const requesterId = await resolveUser(req, reply);
    if (!requesterId) return;
    const parsed = z.object({
      category: z.enum(['account_access', 'profile_update', 'learning_progress', 'exam_access', 'other']),
      subject: z.string().trim().min(5).max(120).refine((value) => !contactPattern.test(value), 'Do not include phone numbers or email addresses.'),
      message: z.string().trim().min(10).max(2000).refine((value) => !contactPattern.test(value), 'Do not include phone numbers or email addresses. Support can use the contact details on your account.'),
      idempotencyKey: z.string().uuid().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });

    const rateKey = `support_request:${createHash('sha256').update(requesterId).digest('hex')}`;
    const idempotencyKey = parsed.data.idempotencyKey ?? null;
    const id = randomUUID();
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      if (idempotencyKey) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          [`support-request:${requesterId}:${idempotencyKey}`],
        );
        const previous = await client.query(`SELECT id, category, subject, message, status,
            staff_note AS "staffNote", created_at AS "createdAt", updated_at AS "updatedAt"
          FROM public.learner_support_requests
          WHERE requester_id=$1::uuid AND idempotency_key=$2::uuid
          LIMIT 1`, [requesterId, idempotencyKey]);
        if (previous.rows[0]) {
          const request = previous.rows[0];
          const samePayload = request.category === parsed.data.category
            && request.subject === parsed.data.subject
            && request.message === parsed.data.message;
          await client.query('COMMIT');
          if (!samePayload) {
            return reply.status(409).send({ error: 'This request key was already used for different details. Start a new request.' });
          }
          return reply.code(200).send({ request });
        }
      }

      const limit = await redis.checkRateLimit(rateKey, 3, 86400);
      if (!limit.allowed) {
        await client.query('ROLLBACK');
        return reply.status(429).send({ error: 'You have reached today’s support request limit. Please try again tomorrow.' });
      }

      const result = await client.query(`INSERT INTO public.learner_support_requests
          (id, requester_id, idempotency_key, category, subject, message)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)
        RETURNING id, category, subject, message, status,
          staff_note AS "staffNote", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [id, requesterId, idempotencyKey, parsed.data.category, parsed.data.subject, parsed.data.message]);
      await client.query(`INSERT INTO public.staff_audit_logs
          (actor_email, actor_role, action, entity_type, entity_id, metadata)
        VALUES ($1, 'learner', 'support.request.created', 'support_request', $2, $3::jsonb)`,
      [`learner:${createHash('sha256').update(requesterId).digest('hex').slice(0, 20)}`, id, JSON.stringify({ category: parsed.data.category })]);
      await client.query('COMMIT');
      return reply.code(201).send({ request: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      req.log.error({ err }, 'Learner support request creation failed');
      return reply.status(503).send({ error: 'Your request could not be saved. Please try again later.' });
    } finally { client.release(); }
  });
};
