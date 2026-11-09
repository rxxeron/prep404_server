import { createHash, randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Pool } from 'pg';
import { RedisService } from '../redis/redis.service';
import { SupabaseAuthVerificationError, verifySupabaseAccessToken } from '../services/supabase_auth.service';
import { AiTutorOutcome, recordAiTutorUsage } from '../services/ai_tutor_telemetry.service';

export const aiRoutes: FastifyPluginAsync<{ db: Pool; redis: RedisService }> = async (app: FastifyInstance, opts) => {
  const { db, redis } = opts;

  app.post('/api/v1/ai/response-reports', async (req, reply) => {
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) return reply.status(401).send({ error: 'Sign in to report a tutor response.' });
    let reporterId: string;
    try {
      reporterId = (await verifySupabaseAccessToken(bearer)).id;
    } catch (err) {
      const status = err instanceof SupabaseAuthVerificationError ? err.statusCode : 503;
      return reply.status(status).send({ error: status === 401 ? 'Your sign-in has expired.' : 'Sign-in verification is temporarily unavailable.' });
    }

    const parsed = z.object({
      category: z.enum(['incorrect', 'unsafe', 'irrelevant', 'other']),
      questionId: z.string().uuid(),
      responseText: z.string().trim().min(1).max(4000),
    }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });

    const rateKey = `ai_response_report:${createHash('sha256').update(reporterId).digest('hex')}`;
    if (!(await redis.checkRateLimit(rateKey, 10, 86400)).allowed) {
      return reply.status(429).send({ error: 'You have reached today’s response report limit.' });
    }

    const redactContact = (value: string) => value
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email redacted]')
      .replace(/(?:\+?880|0)?1[3-9](?:[\s()-]*\d){8}/g, '[phone redacted]');
    const id = randomUUID();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const source = await client.query(`SELECT hints FROM public.questions
        WHERE id=$1::uuid AND is_active=true AND review_status='approved' FOR KEY SHARE`, [parsed.data.questionId]);
      const authoredHints = Array.isArray(source.rows[0]?.hints) ? source.rows[0].hints : [];
      if (!source.rowCount || !authoredHints.some((hint: unknown) => typeof hint === 'string' && hint.trim() === parsed.data.responseText)) {
        await client.query('ROLLBACK');
        return reply.status(400).send({ error: 'This hint is no longer available to report.' });
      }
      await client.query(`INSERT INTO public.ai_response_reports
          (id, reporter_id, question_id, category, response_text)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5)`, [id, reporterId, parsed.data.questionId, parsed.data.category, redactContact(parsed.data.responseText)]);
      await client.query(`INSERT INTO public.staff_audit_logs
          (actor_email, actor_role, action, entity_type, entity_id, metadata)
        VALUES ($1,'learner','ai_response.reported','ai_response_report',$2,$3::jsonb)`,
      [`learner:${createHash('sha256').update(reporterId).digest('hex').slice(0, 20)}`, id, JSON.stringify({ category: parsed.data.category, questionId: parsed.data.questionId })]);
      await client.query('COMMIT');
      return reply.code(201).send({ success: true, id });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      req.log.error({ err }, 'AI tutor response report could not be saved');
      return reply.status(503).send({ error: 'This response could not be reported right now.' });
    } finally { client.release(); }
  });

  // This route streams only approved, question-authored hints. No AI provider
  // is configured in this build, so it never fabricates a generic answer.
  app.post('/api/v1/ai/doubt-solver', async (req, reply) => {
    const startedAt = process.hrtime.bigint();
    const recordUsage = async (outcome: AiTutorOutcome) => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      try { await recordAiTutorUsage(db, outcome, elapsedMs); }
      catch (err) { req.log.warn({ err }, 'AI tutor usage telemetry unavailable'); }
    };
    const parsed = z.object({
      questionId: z.string().uuid(),
      currentHintLevel: z.number().int().min(1).max(20).default(1),
    }).safeParse(req.body);
    if (!parsed.success) {
      await recordUsage('invalid_request');
      return reply.status(400).send({ error: parsed.error.errors[0].message });
    }

    const address = req.ip || 'unknown';
    const rateKey = `authored_hint:${createHash('sha256').update(address).digest('hex')}`;
    if (!(await redis.checkRateLimit(rateKey, 60, 60)).allowed) {
      await recordUsage('rate_limited');
      return reply.status(429).send({ error: 'Too many hint requests. Please try again shortly.' });
    }

    let hints: unknown;
    try {
      const result = await db.query(`SELECT hints FROM public.questions
        WHERE id=$1::uuid AND is_active=true AND review_status='approved'`, [parsed.data.questionId]);
      if (!result.rowCount) {
        await recordUsage('not_found');
        return reply.status(404).send({ error: 'Approved question not found.' });
      }
      hints = result.rows[0].hints;
    } catch (err) {
      req.log.error({ err }, 'Authored hint lookup failed');
      await recordUsage('failure');
      return reply.status(503).send({ error: 'Study hints are temporarily unavailable.' });
    }

    const list = Array.isArray(hints) ? hints : [];
    const hint = list[parsed.data.currentHintLevel - 1];
    if (typeof hint !== 'string' || !hint.trim()) {
      await recordUsage('no_hint');
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.write(`data: ${JSON.stringify({ done: true, hintAvailable: false })}\n\n`);
      return reply.raw.end();
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    for (const char of hint.trim()) {
      if (reply.raw.destroyed) {
        await recordUsage('failure');
        return;
      }
      reply.raw.write(`data: ${JSON.stringify({ char, done: false })}\n\n`);
      await new Promise((res) => setTimeout(res, 20));
    }
    await recordUsage('success');
    reply.raw.write(`data: ${JSON.stringify({ done: true, hintAvailable: true })}\n\n`);
    return reply.raw.end();
  });
};
