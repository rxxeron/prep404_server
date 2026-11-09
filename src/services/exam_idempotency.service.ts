import { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.service';

type IdempotencyContext = {
  storageKey: string;
  requestHash: string;
  ownerToken: string;
  isOwner: boolean;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Idempotency-Key support for exam submissions. Fastify hooks are scoped to
 * the plugin that adds them, so every plugin that owns a submit route calls
 * this: the authenticated exam routes and the public candidate exam routes.
 *
 * `resolveCallerId` returns the verified learner ID, or null for anonymous
 * callers (their key is then scoped to the exam session or IP).
 */
export function registerExamSubmissionIdempotency(
  app: FastifyInstance,
  redis: RedisService,
  resolveCallerId: (req: FastifyRequest) => Promise<string | null>,
): void {
  const idempotencyContexts = new WeakMap<FastifyRequest, IdempotencyContext>();

  app.addHook('preHandler', async (req, reply) => {
    const pathname = req.url.split('?')[0];
    if (
      req.method !== 'POST' ||
      !/^\/api\/v1\/(?:public\/)?exam\/[^/]+\/submit(?:-session)?$/.test(pathname)
    ) {
      return;
    }

    const rawKey = req.headers['idempotency-key'];
    if (rawKey === undefined) return;
    if (
      typeof rawKey !== 'string' ||
      rawKey.length < 8 ||
      rawKey.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(rawKey)
    ) {
      return reply.status(400).send({
        error: 'Idempotency-Key must be 8-128 safe characters.',
        code: 'INVALID_IDEMPOTENCY_KEY',
      });
    }

    const callerId = await resolveCallerId(req);
    const callerScope = callerId || (typeof (req.body as any)?.sessionId === 'string' && (req.body as any).sessionId ? (req.body as any).sessionId : req.ip);

    const requestHash = createHash('sha256')
      .update(stableJson({ method: req.method, pathname, body: req.body }))
      .digest('hex');
    const storageKey = `idempotency:exam:${createHash('sha256')
      .update(`${pathname}:${callerScope}:${rawKey}`)
      .digest('hex')}`;
    const ownerToken = randomUUID();
    let claim;
    try {
      claim = await redis.claimIdempotencyKey(
        storageKey,
        requestHash,
        ownerToken,
      );
    } catch {
      return reply.status(503).send({
        error: 'Idempotency service is currently unavailable. Please retry shortly.',
        code: 'IDEMPOTENCY_UNAVAILABLE',
      });
    }

    if (claim.state === 'conflict') {
      return reply.status(409).send({
        error: 'This Idempotency-Key was already used for a different request.',
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    }

    if (claim.state === 'replay') {
      // The original request already finished: return its stored response
      // instead of running the submission a second time.
      return reply
        .header('Idempotency-Replayed', 'true')
        .code(claim.statusCode)
        .send(claim.body);
    }

    if (claim.state === 'in_progress') {
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        let current;
        try {
          current = await redis.readIdempotencyKey(storageKey, requestHash);
        } catch {
          return reply.status(503).send({
            error: 'Idempotency service is currently unavailable. Please retry shortly.',
            code: 'IDEMPOTENCY_UNAVAILABLE',
          });
        }
        if (current?.state === 'conflict') {
          return reply.status(409).send({
            error: 'This Idempotency-Key was already used for a different request.',
            code: 'IDEMPOTENCY_KEY_REUSED',
          });
        }
        if (current?.state === 'replay') {
          return reply
            .header('Idempotency-Replayed', 'true')
            .code(current.statusCode)
            .send(current.body);
        }
        if (!current) {
          try {
            claim = await redis.claimIdempotencyKey(
              storageKey,
              requestHash,
              ownerToken,
            );
          } catch {
            return reply.status(503).send({
              error: 'Idempotency service is currently unavailable. Please retry shortly.',
              code: 'IDEMPOTENCY_UNAVAILABLE',
            });
          }
          if (claim.state === 'claimed') break;
          if (claim.state === 'conflict') {
            return reply.status(409).send({
              error: 'This Idempotency-Key was already used for a different request.',
              code: 'IDEMPOTENCY_KEY_REUSED',
            });
          }
        }
      }
      if (claim.state !== 'claimed') {
        return reply
          .header('Retry-After', '1')
          .status(409)
          .send({
            error: 'The original submission is still processing. Retry with the same key.',
            code: 'IDEMPOTENCY_IN_PROGRESS',
          });
      }
    }

    idempotencyContexts.set(req, {
      storageKey,
      requestHash,
      ownerToken,
      isOwner: true,
    });
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const context = idempotencyContexts.get(req);
    if (!context?.isOwner) return payload;

    if (reply.statusCode >= 500 || reply.statusCode === 429 || reply.statusCode === 401 || reply.statusCode === 403) {
      await redis.releaseIdempotencyKey(
        context.storageKey,
        context.requestHash,
        context.ownerToken,
      );
      return payload;
    }

    try {
      const body = Buffer.isBuffer(payload)
        ? JSON.parse(payload.toString('utf8'))
        : typeof payload === 'string'
          ? JSON.parse(payload)
          : payload;
      await redis.completeIdempotencyKey(
        context.storageKey,
        context.requestHash,
        context.ownerToken,
        reply.statusCode,
        body,
      );
    } catch (_) {
      await redis.releaseIdempotencyKey(
        context.storageKey,
        context.requestHash,
        context.ownerToken,
      );
    }
    return payload;
  });

  app.addHook('onError', async (req) => {
    const context = idempotencyContexts.get(req);
    if (!context?.isOwner) return;
    await redis.releaseIdempotencyKey(
      context.storageKey,
      context.requestHash,
      context.ownerToken,
    );
  });
}
