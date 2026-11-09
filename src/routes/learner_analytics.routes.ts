import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { RedisService } from '../redis/redis.service';
import { SupabaseAuthVerificationError, verifySupabaseAccessToken } from '../services/supabase_auth.service';
import { recordLearnerEvent } from '../services/learner_analytics.service';

export const learnerAnalyticsRoutes: FastifyPluginAsync<{ db: Pool; redis?: RedisService }> = async (app: FastifyInstance, { db, redis }) => {
  const resolveUser = async (req: any, reply: any): Promise<string | null> => {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) { reply.code(401).send({ error: 'Sign in to manage analytics consent.' }); return null; }
    try { return (await verifySupabaseAccessToken(token)).id; }
    catch (error) {
      const status = error instanceof SupabaseAuthVerificationError ? error.statusCode : 503;
      reply.code(status).send({ error: status === 401 ? 'Your sign-in has expired. Sign in again.' : 'Sign-in verification is temporarily unavailable.' });
      return null;
    }
  };

  app.get('/api/v1/user/analytics-consent', async (req, reply) => {
    const userId = await resolveUser(req, reply); if (!userId) return;
    try {
      const result = await db.query(`SELECT enabled, policy_version AS "policyVersion", updated_at AS "updatedAt"
        FROM public.learner_analytics_consent WHERE user_id=$1::uuid`, [userId]);
      return {
        enabled: result.rows.length === 0 ? true : Boolean(result.rows[0]?.enabled),
        policyVersion: result.rows[0]?.policyVersion || '2026-10-v1',
        updatedAt: result.rows[0]?.updatedAt || null
      };
    } catch (error) { req.log.error({ err: error }, 'Unable to read analytics consent'); return reply.code(503).send({ error: 'Analytics settings are temporarily unavailable.' }); }
  });

  app.put('/api/v1/user/analytics-consent', async (req, reply) => {
    const userId = await resolveUser(req, reply); if (!userId) return;
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Choose whether optional analytics are enabled.' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const previous = await client.query(`SELECT enabled FROM public.learner_analytics_consent WHERE user_id=$1::uuid FOR UPDATE`, [userId]);
      const previouslyEnabled = previous.rows.length === 0 ? true : previous.rows[0]?.enabled === true;
      const shouldRecordGrant = parsed.data.enabled && !previouslyEnabled;
      await client.query(`INSERT INTO public.learner_analytics_consent (user_id, enabled, policy_version, updated_at)
        VALUES ($1::uuid, $2, '2026-10-v1', now())
        ON CONFLICT (user_id) DO UPDATE SET enabled=EXCLUDED.enabled, policy_version=EXCLUDED.policy_version, updated_at=now()`, [userId, parsed.data.enabled]);
      if (!parsed.data.enabled) await client.query('DELETE FROM public.learner_analytics_events WHERE user_id=$1::uuid', [userId]);
      if (shouldRecordGrant) {
        await client.query(`INSERT INTO public.learner_analytics_events (user_id,event_name)
          VALUES ($1::uuid,'analytics_consent_granted')`, [userId]);
      }
      await client.query('COMMIT');
      return { enabled: parsed.data.enabled, policyVersion: '2026-10-v1', deletedEventsOnWithdrawal: !parsed.data.enabled };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); req.log.error({ err: error }, 'Unable to update analytics consent'); return reply.code(503).send({ error: 'Analytics settings could not be saved.' }); }
    finally { client.release(); }
  });

  // This endpoint only accepts the fixed app-open event and derives identity from the verified token.
  app.post('/api/v1/user/analytics-events/app-open', async (req, reply) => {
    const userId = await resolveUser(req, reply); if (!userId) return;
    const parsed = z.object({
      deviceType: z.enum(['android', 'ios', 'web', 'other']).optional(),
      appVersion: z.string().regex(/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(\+[0-9]{1,6})?$/).optional(),
      locale: z.string().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/).optional(),
    }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'App analytics context is invalid.' });
    const rateKey = `analytics_app_open:${createHash('sha256').update(userId).digest('hex')}`;
    const rate = await redis?.checkRateLimit(rateKey, 30, 60);
    if (rate && !rate.allowed) return reply.code(202).send({ accepted: false });
    try { await recordLearnerEvent(db, userId, 'app_open', parsed.data); return reply.code(202).send({ accepted: true }); }
    catch (error) { req.log.warn({ err: error }, 'Optional learner event was not recorded'); return reply.code(202).send({ accepted: false }); }
  });
};
