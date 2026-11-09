import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { supportRoutes } from '../src/routes/support.routes';
import { installSupabaseAuthStub, learnerToken } from './helpers/supabase_auth_stub';

const learnerId = '20000000-0000-4000-8000-000000000987';
const submissionKey = '40000000-0000-4000-8000-000000000987';

async function createApp() {
  const rows = new Map<string, Record<string, unknown>>();
  let insertCount = 0;
  let auditCount = 0;
  let rateLimitCalls = 0;
  let advisoryLockCalls = 0;

  const db = {
    async connect() {
      return {
        async query(sql: string, values: unknown[] = []) {
          if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rowCount: 0, rows: [] };
          if (sql.includes('pg_advisory_xact_lock')) {
            advisoryLockCalls++;
            return { rowCount: 1, rows: [{ pg_advisory_xact_lock: null }] };
          }
          if (sql.includes('FROM public.learner_support_requests') && sql.includes('idempotency_key')) {
            return { rowCount: rows.has(String(values[1])) ? 1 : 0, rows: rows.has(String(values[1])) ? [rows.get(String(values[1]))] : [] };
          }
          if (sql.includes('INSERT INTO public.learner_support_requests')) {
            insertCount++;
            const hasIdempotencyKey = sql.includes('idempotency_key');
            const offset = hasIdempotencyKey ? 1 : 0;
            const row = {
              id: values[0],
              category: values[2 + offset],
              subject: values[3 + offset],
              message: values[4 + offset],
              status: 'open',
              staffNote: null,
              createdAt: '2026-11-01T00:00:00.000Z',
              updatedAt: '2026-11-01T00:00:00.000Z',
            };
            if (hasIdempotencyKey) rows.set(String(values[2]), row);
            return { rowCount: 1, rows: [row] };
          }
          if (sql.includes('INSERT INTO public.staff_audit_logs')) {
            auditCount++;
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`Unexpected support test SQL: ${sql.slice(0, 90)}`);
        },
        release() {},
      };
    },
  };
  const redis = {
    async checkRateLimit() {
      rateLimitCalls++;
      return { allowed: rateLimitCalls === 1, remaining: 0 };
    },
  };
  const app = Fastify({ logger: false });
  await app.register(supportRoutes, { db: db as any, redis: redis as any });
  await app.ready();
  return { app, get counts() { return { insertCount, auditCount, rateLimitCalls, advisoryLockCalls }; } };
}

void (async () => {
  const restoreAuth = installSupabaseAuthStub();
  const fixture = await createApp();
  try {
    const payload = {
      category: 'learning_progress',
      subject: 'Progress did not update',
      message: 'My saved topic progress did not update after practice.',
      idempotencyKey: submissionKey,
    };
    const headers = { authorization: `Bearer ${learnerToken(learnerId)}` };

    const first = await fixture.app.inject({ method: 'POST', url: '/api/v1/support/requests', headers, payload });
    assert.equal(first.statusCode, 201, first.body);
    const firstRequestId = first.json().request.id;

    const retry = await fixture.app.inject({ method: 'POST', url: '/api/v1/support/requests', headers, payload });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().request.id, firstRequestId, 'A retry must replay the already saved request');
    assert.deepEqual(fixture.counts, { insertCount: 1, auditCount: 1, rateLimitCalls: 1, advisoryLockCalls: 2 });

    const changedPayload = { ...payload, message: 'This is a different support request body.' };
    const conflict = await fixture.app.inject({ method: 'POST', url: '/api/v1/support/requests', headers, payload: changedPayload });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.deepEqual(fixture.counts, { insertCount: 1, auditCount: 1, rateLimitCalls: 1, advisoryLockCalls: 3 });
  } finally {
    await fixture.app.close();
    restoreAuth();
  }
  console.log('Support request retries replay one saved case and do not consume the daily limit twice.');
})();
