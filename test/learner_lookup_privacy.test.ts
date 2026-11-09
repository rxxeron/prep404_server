import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { managementRoutes } from '../src/routes/management.routes';

const staffId = 'support-lookup-test-staff';
const learnerId = '20000000-0000-4000-8000-000000000123';
const phone = '01712345678';

async function createLookupApp(matches: 'found' | 'not_found' | 'ambiguous') {
  const auditRows: unknown[][] = [];
  const lookupQueries: Array<{ sql: string; values: unknown[] }> = [];
  let connectCount = 0;
  const db = {
    async query() { return { rowCount: 0, rows: [] }; },
    async connect() {
      connectCount++;
      return {
        async query(sql: string, values: unknown[] = []) {
          if (sql.includes("right(regexp_replace(COALESCE(u.phone,''),'[^0-9]','','g'),4)")) {
            lookupQueries.push({ sql, values });
            const learner = {
              id: learnerId,
              fullName: 'Sample Learner',
              phoneLastFour: phone.slice(-4),
              track: 'private_uni',
              createdAt: '2026-01-01T00:00:00.000Z',
              totalXp: 120,
              examSubmissions: 3,
              topicsTracked: 2,
              averageTopicAccuracy: 76.5,
              lastObservedActivityAt: '2026-10-01T00:00:00.000Z',
            };
            return { rows: matches === 'found' ? [learner] : matches === 'ambiguous' ? [learner, { ...learner, id: randomUUID() }] : [] };
          }
          if (sql.includes('INSERT INTO public.staff_audit_logs')) {
            auditRows.push(values);
          }
          return { rowCount: 1, rows: [] };
        },
        release() {},
      };
    },
  };
  const redis = { async get() { return staffId; } };
  const app = Fastify({ logger: false });
  app.decorate('db', db as any);
  app.decorate('redisService', redis as any);
  void app.register(jwt, { secret: 'learner-lookup-test-only-secret' });
  void app.register(managementRoutes, { db: db as any, redis: redis as any });
  await app.ready();

  const token = app.jwt.sign({
    userId: staffId,
    email: 'support@example.test',
    role: 'support',
    sessionId: randomUUID(),
  });

  return { app, token, auditRows, lookupQueries, getConnectCount: () => connectCount };
}

async function testFoundLookupReturnsOnlyMaskedPhoneAndAuditsNoSearchTerm() {
  const fixture = await createLookupApp('found');
  try {
    const response = await fixture.app.inject({
      method: 'GET',
      url: `/api/v1/management/support/learners/lookup?query=${phone}`,
      headers: { authorization: `Bearer ${fixture.token}` },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.learner.phoneLastFour, phone.slice(-4));
    assert.equal(JSON.stringify(body).includes(phone), false, 'Full phone must never appear in the lookup response');
    assert.equal(fixture.lookupQueries.length, 1);
    assert.deepEqual(fixture.auditRows, [[
      'support@example.test', 'support', 'learner.lookup', 'learner', learnerId, '{"result":"found"}',
    ]]);
    assert.equal(JSON.stringify(fixture.auditRows).includes(phone), false, 'The audit row must not retain the searched phone');
  } finally {
    await fixture.app.close();
  }
}

async function testNotFoundAndAmbiguousLookupAuditOnlyOutcome() {
  for (const [match, status, entityId, result] of [
    ['not_found', 404, 'not_found', 'not_found'],
    ['ambiguous', 409, 'ambiguous', 'ambiguous'],
  ] as const) {
    const fixture = await createLookupApp(match);
    try {
      const response = await fixture.app.inject({
        method: 'GET',
        url: `/api/v1/management/support/learners/lookup?query=${phone}`,
        headers: { authorization: `Bearer ${fixture.token}` },
      });
      assert.equal(response.statusCode, status);
      assert.deepEqual(fixture.auditRows, [[
        'support@example.test', 'support', 'learner.lookup', 'learner', entityId, JSON.stringify({ result }),
      ]]);
      assert.equal(JSON.stringify(response.json()).includes(phone), false);
      assert.equal(JSON.stringify(fixture.auditRows).includes(phone), false);
    } finally {
      await fixture.app.close();
    }
  }
}

async function testInvalidLookupIsRejectedBeforeDatabaseAccess() {
  const fixture = await createLookupApp('not_found');
  try {
    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/management/support/learners/lookup?query=not-a-phone',
      headers: { authorization: `Bearer ${fixture.token}` },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(fixture.getConnectCount(), 0);
    assert.equal(fixture.auditRows.length, 0);
  } finally {
    await fixture.app.close();
  }
}

void (async () => {
  await testFoundLookupReturnsOnlyMaskedPhoneAndAuditsNoSearchTerm();
  await testNotFoundAndAmbiguousLookupAuditOnlyOutcome();
  await testInvalidLookupIsRejectedBeforeDatabaseAccess();
  console.log('Learner lookup phone minimization and audit privacy checks passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
