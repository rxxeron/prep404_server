import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { managementRoutes } from '../src/routes/management.routes';

const staffId = 'content-coverage-test-setter';
const affectedQuestionId = '40000000-0000-4000-8000-000000000002';

async function testCoverageRouteReturnsActionableExamIssues() {
  const queries: string[] = [];
  const db = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes('WITH topic_counts')) return { rowCount: 0, rows: [] };
      if (sql.includes('multipleCorrectOptionSets')) {
        return { rowCount: 1, rows: [{ shortStems: 0, missingExplanations: 0, invalidOptionSets: 0, multipleCorrectOptionSets: 0 }] };
      }
      if (sql.includes('WITH exam_checks')) {
        return {
          rowCount: 1,
          rows: [{
            publishedExams: 1,
            withoutQuestions: 0,
            overQuestionLimit: 0,
            withNonReadyQuestions: 1,
            nonReadyQuestionLinks: 1,
            inWindowWithNonReadyQuestions: 1,
            inWindowNonReadyQuestionLinks: 1,
            missingStartTime: 0,
            invalidScheduleWindows: 0,
            withinScheduleWindow: 1,
            issueCount: 1,
            issues: [{
              examId: '50000000-0000-4000-8000-000000000005',
              title: 'Live Test Exam',
              track: 'private_uni',
              startsAt: '2026-10-30T10:00:00.000Z',
              endsAt: '2026-10-30T11:00:00.000Z',
              questionCount: 20,
              nonReadyQuestionLinks: 1,
              nonReadyQuestionIds: [affectedQuestionId],
              reasons: ['non_ready_question_links'],
            }],
          }],
        };
      }
      if (sql.includes('WITH question_performance')) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected content coverage query: ${sql.slice(0, 70)}`);
    },
  };
  const redis = { async get() { return staffId; } };
  const app = Fastify({ logger: false });
  app.decorate('db', db as any);
  app.decorate('redisService', redis as any);
  await app.register(jwt, { secret: 'content-coverage-test-only-secret' });
  await app.register(managementRoutes, { db: db as any, redis: redis as any });
  await app.ready();

  try {
    const token = app.jwt.sign({ userId: staffId, email: 'setter@example.test', role: 'setter', sessionId: randomUUID() });
    const response = await app.inject({ method: 'GET', url: '/api/v1/management/coverage', headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 200);
    const integrity = response.json().examIntegrity;
    assert.equal(integrity.issueCount, 1);
    assert.equal(integrity.issues[0].examId, '50000000-0000-4000-8000-000000000005');
    assert.deepEqual(integrity.issues[0].nonReadyQuestionIds, [affectedQuestionId]);
    assert.deepEqual(integrity.issues[0].reasons, ['non_ready_question_links']);
    assert.equal(queries.length, 4);
    assert.ok(queries.every((query) => /^\s*(SELECT|WITH)/i.test(query)), 'Coverage review must remain read-only');
    const issueQuery = queries.find((query) => query.includes('WITH exam_checks')) || '';
    assert.match(issueQuery, /array_agg\(eq\.question_id::text ORDER BY eq\.question_order\)/i);
    assert.match(issueQuery, /LIMIT 250/);
  } finally {
    await app.close();
  }
}

void testCoverageRouteReturnsActionableExamIssues().then(() => {
  console.log('Content coverage issue-list API checks passed.');
});
