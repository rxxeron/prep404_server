import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { authRoutes } from '../src/routes/auth.routes';
import { hashStaffPassword } from '../src/services/staff_credentials.service';

const email = 'staff@example.test';
const password = 'long-enough-test-password';
const staffId = '10000000-0000-4000-8000-000000000001';

function createMocks(auditFails = false) {
  const auditCalls: Array<{ sql: string; values: unknown[] }> = [];
  const redisCalls = { set: [] as Array<{ key: string; value: string }>, del: [] as string[] };
  const db = {
    async query(sql: string, values: unknown[] = []) {
      if (/FROM public\.staff_members\s+WHERE lower\(email\)/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            id: staffId,
            email,
            username: 'staff',
            full_name: 'Test Staff',
            role: 'super_admin',
            password_hash: hashStaffPassword(password),
            is_active: true,
            session_version: 1,
          }],
        };
      }
      auditCalls.push({ sql, values });
      if (auditFails) throw new Error('audit unavailable');
      return { rowCount: 1, rows: [] };
    },
  };
  const redis = {
    async checkRateLimit() { return { allowed: true, remaining: 7, resetInSeconds: 900 }; },
    async set(key: string, value: string) { redisCalls.set.push({ key, value }); },
    async del(key: string) { redisCalls.del.push(key); return true; },
  };
  return { db, redis, auditCalls, redisCalls };
}

async function createApp(mocks: ReturnType<typeof createMocks>) {
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: 'test-only-jwt-secret' });
  await app.register(authRoutes, { db: mocks.db as any, redis: mocks.redis as any });
  await app.ready();
  return app;
}

async function testSuccessfulSignInIsAudited() {
  const mocks = createMocks();
  const app = await createApp(mocks);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/staff/auth/login',
      payload: { identifier: 'staff', password },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(mocks.auditCalls.length, 1);
    const audit = mocks.auditCalls[0];
    assert.match(audit.sql, /'staff\.session\.created'/);
    assert.equal(audit.values[0], email);
    assert.equal(audit.values[1], 'super_admin');
    assert.match(String(audit.values[2]), /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(String(audit.values[3])), { scope: 'current_session', managedAccount: true });
    assert.equal(String(audit.values[2]).includes(response.json().token), false);
    assert.equal(mocks.redisCalls.set.length, 1);
    assert.equal(mocks.redisCalls.set[0].value, staffId);
    assert.equal(mocks.redisCalls.del.length, 0);
  } finally {
    await app.close();
  }
}

async function testAuditFailureRevokesUnissuedSession() {
  const mocks = createMocks(true);
  const app = await createApp(mocks);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/staff/auth/login',
      payload: { identifier: email, password },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'Staff sign-in is temporarily unavailable. Please try again.');
    assert.equal(mocks.redisCalls.set.length, 1);
    assert.deepEqual(mocks.redisCalls.del, [mocks.redisCalls.set[0].key]);
  } finally {
    await app.close();
  }
}

async function testGoogleSignInIssuesOnlyProvisionedStaffSession() {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL = 'https://auth.example.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key';
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), 'https://auth.example.test/auth/v1/user');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer supabase-google-access-token');
    return new Response(JSON.stringify({
      id: '20000000-0000-4000-8000-000000000002',
      email,
      email_confirmed_at: '2026-10-30T00:00:00.000Z',
      app_metadata: { providers: ['google'] },
      user_metadata: { full_name: 'Ignored for role authorization' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const mocks = createMocks();
  const app = await createApp(mocks);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/staff/auth/google',
      headers: { authorization: 'Bearer supabase-google-access-token' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().staff.email, email);
    assert.equal(response.json().staff.role, 'super_admin');
    assert.equal(mocks.redisCalls.set.length, 1);
    assert.equal(mocks.redisCalls.set[0].value, staffId);
    assert.equal(mocks.auditCalls.length, 1);
    const audit = mocks.auditCalls[0];
    assert.equal(audit.values[0], email);
    assert.equal(audit.values[1], 'super_admin');
    assert.deepEqual(JSON.parse(String(audit.values[3])), {
      scope: 'current_session', managedAccount: true, authMethod: 'google',
    });
    assert.equal(JSON.stringify(audit.values).includes('supabase-google-access-token'), false);
  } finally {
    await app.close();
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = previousKey;
  }
}

async function testGoogleSignInRejectsEmailProviderAndUnverifiedEmail() {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL = 'https://auth.example.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key';
  let identity: {
    id: string;
    email: string;
    email_confirmed_at: string | null;
    app_metadata: { providers: string[] };
  } = {
    id: '20000000-0000-4000-8000-000000000002',
    email,
    email_confirmed_at: '2026-10-30T00:00:00.000Z',
    app_metadata: { providers: ['email'] },
  };
  globalThis.fetch = (async () => new Response(JSON.stringify(identity), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

  const mocks = createMocks();
  const app = await createApp(mocks);
  try {
    for (const user of [
      identity,
      { ...identity, email_confirmed_at: null, app_metadata: { providers: ['google'] } },
    ]) {
      identity = user;
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/staff/auth/google',
        headers: { authorization: 'Bearer supabase-access-token' },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, 'This Google account is not authorized for staff access.');
    }
    assert.equal(mocks.redisCalls.set.length, 0);
    assert.equal(mocks.auditCalls.length, 0);
  } finally {
    await app.close();
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = previousKey;
  }
}

void (async () => {
  await testSuccessfulSignInIsAudited();
  await testAuditFailureRevokesUnissuedSession();
  await testGoogleSignInIssuesOnlyProvisionedStaffSession();
  await testGoogleSignInRejectsEmailProviderAndUnverifiedEmail();
  console.log('Staff password/Google sign-in audit and authorization checks passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
