import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Pool } from 'pg';
import { RedisService } from '../redis/redis.service';
import { TelemetryBatchService, LogLevel, LogSource } from '../services/telemetry_batch.service';
import { verifySupabaseAccessToken } from '../services/supabase_auth.service';

const LogItemSchema = z.object({
  occurredAt: z.string().optional(),
  level: z.enum(['debug', 'info', 'warn', 'error', 'fatal', 'crash']).default('info'),
  source: z.enum(['app', 'server', 'auth', 'exam', 'battle', 'network', 'system']).default('app'),
  userId: z.string().optional().nullable(),
  event: z.string().min(1).max(100),
  message: z.string().optional().nullable(),
  errorStack: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().default({}),
});

const IngestLogsSchema = z.object({
  logs: z.array(LogItemSchema).min(1).max(200),
});

export const telemetryRoutes: FastifyPluginAsync<{ db: Pool; redis: RedisService }> = async (
  app: FastifyInstance,
  opts: { db: Pool; redis: RedisService }
) => {
  const telemetryService = TelemetryBatchService.initialize(opts.db, opts.redis);

  // Ingest client and app logs (accepts array or single entry)
  app.post('/api/v1/telemetry/logs', async (req: FastifyRequest, reply: FastifyReply) => {
    let candidateUserId: string | null = null;
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) {
      try {
        candidateUserId = (await verifySupabaseAccessToken(bearer)).id;
      } catch (_) {}
    }

    const body = req.body;
    // Support either { logs: [...] } or direct single log object
    const payload = Array.isArray((body as any)?.logs)
      ? (body as any).logs
      : Array.isArray(body)
      ? body
      : [body];

    const parseResult = IngestLogsSchema.safeParse({ logs: payload });
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid telemetry payload',
        details: parseResult.error.errors[0]?.message,
      });
    }

    const entries = parseResult.data.logs.map((item) => ({
      occurredAt: item.occurredAt || new Date().toISOString(),
      level: item.level as LogLevel,
      source: item.source as LogSource,
      userId: item.userId || candidateUserId || null,
      event: item.event,
      message: item.message || null,
      errorStack: item.errorStack || null,
      metadata: item.metadata,
    }));

    await telemetryService.enqueueBatch(entries);

    return reply.status(202).send({
      success: true,
      buffered: entries.length,
    });
  });

  // Diagnostics / Queue telemetry status
  app.get('/api/v1/telemetry/status', async (_req: FastifyRequest, reply: FastifyReply) => {
    const queueLength = await opts.redis.llen('logs:system:buffer');
    return {
      status: 'operational',
      bufferQueueLength: queueLength,
      batchThreshold: 500,
      flushIntervalSeconds: 30,
    };
  });

  // Force trigger flush (e.g. for testing or diagnostics)
  app.post('/api/v1/telemetry/flush', async (_req: FastifyRequest, reply: FastifyReply) => {
    const flushedCount = await telemetryService.flush();
    return {
      success: true,
      flushed: flushedCount,
    };
  });
};
