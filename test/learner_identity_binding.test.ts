import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { accountRoutes } from '../src/routes/account.routes';
import { learnerAnalyticsRoutes } from '../src/routes/learner_analytics.routes';
import { onboardingRoutes } from '../src/routes/onboarding.routes';
import { practiceRoutes } from '../src/routes/practice.routes';
import { installSupabaseAuthStub, learnerToken } from './helpers/supabase_auth_stub';

const authenticatedLearnerId = '20000000-0000-4000-8000-000000000123';
const attackerSuppliedId = '30000000-0000-4000-8000-000000000456';
const jwtSecret = 'learner-identity-test-only-secret';

async function createApp() {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const redisWrites: Array<{ key: string; value: string }> = [];
  const db = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes('SELECT EXISTS')) return { rowCount: 1, rows: [{ complete: false }] };
      if (sql.includes('INSERT INTO users')) {
        writes.push({ sql, values });
        return { rowCount: 1, rows: [{ id: authenticatedLearnerId, full_name: 'Test Candidate' }] };
      }
      if (sql.includes('INSERT INTO public.learner_analytics_events')) {
        writes.push({ sql, values });
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected onboarding query: ${sql.slice(0, 60)}`);
    },
  };
  const redis = {
    async set(key: string, value: string) { redisWrites.push({ key, value }); },
  };
  const app = Fastify({ logger: false });
  app.decorate('db', db as any);
  app.decorate('redisService', redis as any);
  await app.register(jwt, { secret: jwtSecret });
  await app.register(onboardingRoutes, { db: db as any, redis: redis as any });
  await app.ready();
  return { app, writes, redisWrites };
}

const validProfile = {
  id: attackerSuppliedId,
  name: 'Test Candidate',
  medium: 'english',
  academicBatch: '2026',
  institutionName: 'Test College',
  targetSelections: {},
};

async function testOnboardingUsesSignedIdentityInsteadOfBodyId() {
  const fixture = await createApp();
  try {
    const token = learnerToken(authenticatedLearnerId);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/user/onboarding',
      headers: { authorization: `Bearer ${token}` },
      payload: validProfile,
    });

    assert.equal(response.statusCode, 200);
    const profileWrite = fixture.writes.find(({ sql }) => sql.includes('INSERT INTO users'));
    assert.ok(profileWrite, 'The valid signed candidate request should persist a profile');
    assert.equal(profileWrite.values[0], authenticatedLearnerId, 'The signed candidate ID must own the profile write');
    assert.equal(profileWrite.values[2], null, 'Email and Google learners may complete onboarding without a phone number');
    assert.notEqual(profileWrite.values[0], attackerSuppliedId, 'The client supplied ID must not select the profile owner');
    assert.equal(response.json().user.id, authenticatedLearnerId);
    assert.equal(fixture.redisWrites.length, 1);
    assert.equal(fixture.redisWrites[0].key, `profile:${authenticatedLearnerId}`);
  } finally {
    await fixture.app.close();
  }
}

async function testOnboardingRejectsServerSignedLearnerToken() {
  const fixture = await createApp();
  try {
    const forged = fixture.app.jwt.sign({ userId: authenticatedLearnerId });
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/user/onboarding',
      headers: { authorization: `Bearer ${forged}` },
      payload: validProfile,
    });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(fixture.writes.length, 0, 'A server-signed token must not write a learner profile');
  } finally {
    await fixture.app.close();
  }
}

async function testOnboardingWithoutIdentityDoesNotWrite() {
  const fixture = await createApp();
  try {
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/user/onboarding',
      payload: validProfile,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.redisWrites.length, 0);
  } finally {
    await fixture.app.close();
  }
}

async function testLearnerRoutesRejectMissingIdentityBeforeDatabaseAccess() {
  let databaseCalls = 0;
  const db = {
    async query() { databaseCalls++; throw new Error('Unauthenticated learner request reached the database'); },
    async connect() { databaseCalls++; throw new Error('Unauthenticated learner request opened a DB connection'); },
  };
  const redis = {
    async set() { throw new Error('Unauthenticated request wrote profile cache'); },
    async checkRateLimit() { throw new Error('Unauthenticated request reached the rate limiter'); },
  };
  const app = Fastify({ logger: false });
  app.decorate('db', db as any);
  app.decorate('redisService', redis as any);
  await app.register(jwt, { secret: jwtSecret });
  await app.register(accountRoutes, { db: db as any });
  await app.register(learnerAnalyticsRoutes, { db: db as any, redis: redis as any });
  await app.register(onboardingRoutes, { db: db as any, redis: redis as any });
  await app.register(practiceRoutes, { db: db as any, redis: redis as any });
  await app.ready();

  const cases: Array<{ method: 'GET' | 'PUT' | 'POST' | 'DELETE'; url: string; payload?: unknown }> = [
    { method: 'GET', url: '/api/v1/user/analytics-consent' },
    { method: 'PUT', url: '/api/v1/user/analytics-consent', payload: { enabled: true } },
    { method: 'POST', url: '/api/v1/user/analytics-events/app-open', payload: {} },
    { method: 'DELETE', url: '/api/v1/user/account', payload: {} },
    { method: 'POST', url: '/api/v1/practice/attempts', payload: { attemptId: '40000000-0000-4000-8000-000000000001', questionId: '40000000-0000-4000-8000-000000000002', selectedOptionId: 'A' } },
    { method: 'POST', url: '/api/v1/user/onboarding', payload: validProfile },
  ];

  try {
    for (const route of cases) {
      const response = await app.inject(route);
      assert.equal(response.statusCode, 401, `${route.method} ${route.url} must reject missing learner identity`);
    }
    assert.equal(databaseCalls, 0, 'Unauthenticated learner routes must stop before opening or querying the database');
  } finally {
    await app.close();
  }
}

void (async () => {
  const restoreAuth = installSupabaseAuthStub();
  try {
    await testOnboardingUsesSignedIdentityInsteadOfBodyId();
    await testOnboardingRejectsServerSignedLearnerToken();
    await testOnboardingWithoutIdentityDoesNotWrite();
    await testLearnerRoutesRejectMissingIdentityBeforeDatabaseAccess();
  } finally {
    restoreAuth();
  }
  console.log('Learner identity-binding and unauthenticated route checks passed.');
})();
