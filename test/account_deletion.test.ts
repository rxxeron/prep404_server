import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { accountRoutes } from '../src/routes/account.routes';

const learnerId = '20000000-0000-4000-8000-000000000123';
const serviceKey = 'server-only-test-service-key';
const originalFetch = globalThis.fetch;
const originalEnvironment = {
  supabaseUrl: process.env.SUPABASE_URL,
  publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
  anonKey: process.env.SUPABASE_ANON_KEY,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

function configureEnvironment() {
  process.env.SUPABASE_URL = 'https://supabase.example.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
}

function restoreEnvironment() {
  if (originalEnvironment.supabaseUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalEnvironment.supabaseUrl;
  if (originalEnvironment.publishableKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
  else process.env.SUPABASE_PUBLISHABLE_KEY = originalEnvironment.publishableKey;
  if (originalEnvironment.anonKey === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = originalEnvironment.anonKey;
  if (originalEnvironment.serviceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalEnvironment.serviceKey;
}

async function createApp() {
  const dbCalls: Array<{ sql: string; values: unknown[] }> = [];
  let connectCount = 0;
  let committed = false;
  const db = {
    async connect() {
      connectCount++;
      return {
        async query(sql: string, values: unknown[] = []) {
          dbCalls.push({ sql, values });
          if (sql === 'COMMIT') committed = true;
          if (sql === 'ROLLBACK') committed = false;
          return { rowCount: 1, rows: [] };
        },
        release() {},
      };
    },
  };
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: 'account-deletion-test-only-secret' });
  await app.register(accountRoutes, { db: db as any });
  await app.ready();
  return { app, dbCalls, getConnectCount: () => connectCount, getCommitted: () => committed };
}

async function withEnvironment<T>(action: () => Promise<T>): Promise<T> {
  configureEnvironment();
  try { return await action(); }
  finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment();
  }
}

async function testSuccessfulDeletionUsesVerifiedIdentityAndMinimizedAudit() {
  await withEnvironment(async () => {
    const fixture = await createApp();
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: learnerId }), { status: 200 });
      if (url.endsWith(`/auth/v1/admin/users/${learnerId}`)) return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    try {
      const token = 'synthetic-supabase-access-token';
      const response = await fixture.app.inject({
        method: 'DELETE',
        url: '/api/v1/user/account',
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'privacy_concerns' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(fixture.getCommitted(), true);
      assert.equal(fixture.getConnectCount(), 1);
      assert.equal(fetchCalls.length, 2);
      assert.equal(fetchCalls[0].url, 'https://supabase.example.test/auth/v1/user');
      assert.equal(fetchCalls[0].init?.headers && (fetchCalls[0].init.headers as Record<string, string>).Authorization, `Bearer ${token}`);
      assert.equal(fetchCalls[1].url, `https://supabase.example.test/auth/v1/admin/users/${learnerId}`);
      assert.equal((fetchCalls[1].init?.headers as Record<string, string>).Authorization, `Bearer ${serviceKey}`);

      const auditCall = fixture.dbCalls.find(({ sql }) => sql.includes("'learner.account.deleted'"));
      assert.ok(auditCall, 'Successful deletion must record its audit event');
      const expectedHash = createHash('sha256').update(learnerId).digest('hex');
      assert.deepEqual(auditCall.values, [`deleted:${expectedHash}`, JSON.stringify({ subjectHash: expectedHash, channel: 'self_service', reason: 'privacy_concerns' })]);
      assert.equal(JSON.stringify(auditCall.values).includes(learnerId), false, 'Audit fields must not store the raw learner ID');
      assert.ok(fixture.dbCalls.some(({ sql }) => sql.includes('DELETE FROM public.users')));
    } finally { await fixture.app.close(); }
  });
}

async function testAuthDeletionFailureRollsBackProfileAndAudit() {
  await withEnvironment(async () => {
    const fixture = await createApp();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: learnerId }), { status: 200 });
      return new Response(null, { status: 500 });
    }) as typeof fetch;

    try {
      const response = await fixture.app.inject({
        method: 'DELETE',
        url: '/api/v1/user/account',
        headers: { authorization: 'Bearer synthetic-supabase-access-token' },
        payload: { reason: 'technical_issues' },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(fixture.getCommitted(), false);
      assert.ok(fixture.dbCalls.some(({ sql }) => sql === 'ROLLBACK'));
      assert.equal(fixture.dbCalls.some(({ sql }) => sql === 'COMMIT'), false);
    } finally { await fixture.app.close(); }
  });
}

async function testMissingOrInvalidIdentityCannotDelete() {
  await withEnvironment(async () => {
    const fixture = await createApp();
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 401 })) as typeof fetch;
    try {
      const missing = await fixture.app.inject({ method: 'DELETE', url: '/api/v1/user/account', payload: {} });
      const invalid = await fixture.app.inject({
        method: 'DELETE', url: '/api/v1/user/account',
        headers: { authorization: 'Bearer invalid-token' }, payload: {},
      });
      assert.equal(missing.statusCode, 401);
      assert.equal(invalid.statusCode, 401);
      assert.equal(fixture.getConnectCount(), 0);
      assert.equal(fixture.dbCalls.length, 0);
    } finally { await fixture.app.close(); }
  });
}

void (async () => {
  await testSuccessfulDeletionUsesVerifiedIdentityAndMinimizedAudit();
  await testAuthDeletionFailureRollsBackProfileAndAudit();
  await testMissingOrInvalidIdentityCannotDelete();
  console.log('Account deletion verification, audit minimization, and rollback checks passed.');
})().catch((error) => {
  globalThis.fetch = originalFetch;
  restoreEnvironment();
  throw error;
});
