import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { managementRoutes } from '../src/routes/management.routes';

const staffId = 'ai-safety-test-moderator';

async function testUnsafeSignalIncludesReviewOutcomes() {
  const queries: string[] = [];
  const db = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes('SELECT r.id')) return { rowCount: 0, rows: [] };
      if (sql.includes('currentUnsafeReports')) {
        return {
          rowCount: 1,
          rows: [{
            currentUnsafeReports: 4,
            currentDistinctReporters: 2,
            previousUnsafeReports: 1,
            previousDistinctReporters: 1,
            currentOpen: 1,
            currentInReview: 1,
            currentResolved: 1,
            currentDismissed: 1,
          }],
        };
      }
      return { rowCount: 1, rows: [{ total: 4, open: 1, inReview: 1, resolved: 1, dismissed: 1, unsafe: 4 }] };
    },
    async connect() { throw new Error('AI report overview must not open a transaction'); },
  };
  const redis = { async get() { return staffId; } };
  const app = Fastify({ logger: false });
  app.decorate('db', db as any);
  app.decorate('redisService', redis as any);
  await app.register(jwt, { secret: 'ai-safety-test-only-secret' });
  await app.register(managementRoutes, { db: db as any, redis: redis as any });
  await app.ready();

  try {
    const sessionId = randomUUID();
    const token = app.jwt.sign({ userId: staffId, email: 'moderator@example.test', role: 'moderator', sessionId });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/management/ai-response-reports?status=open',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    const trend = response.json().safetyTrend;
    assert.equal(trend.alertTriggered, true);
    assert.deepEqual(
      [trend.currentOpen, trend.currentInReview, trend.currentResolved, trend.currentDismissed],
      [1, 1, 1, 1],
    );
    const activityQuery = queries.find((sql) => sql.includes('currentUnsafeReports')) || '';
    for (const status of ['open', 'in_review', 'resolved', 'dismissed']) {
      assert.match(activityQuery, new RegExp(`status='${status}'`));
    }
  } finally {
    await app.close();
  }
}

void testUnsafeSignalIncludesReviewOutcomes().then(() => {
  console.log('AI unsafe-report signal and review-outcome checks passed.');
});
