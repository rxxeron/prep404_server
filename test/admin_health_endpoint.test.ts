import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { managementRoutes } from '../src/routes/management.routes';

const staffId = 'health-endpoint-test-staff';
const requiredColumns = [
  'exam_id', 'user_id', 'answers', 'score', 'correct_count', 'wrong_count', 'unanswered_count',
  'time_taken_seconds', 'rank', 'idempotency_key', 'is_practice', 'candidate_name',
  'candidate_institution', 'university_code', 'submitted_at',
];

async function testHealthEndpointReportsReadOnlySubmissionReadiness() {
  let databaseWrites = 0;
  const db = {
    totalCount: 3,
    idleCount: 2,
    waitingCount: 0,
    async query(sql: string) {
      if (/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sql)) databaseWrites++;
      if (sql === 'SELECT 1') return { rowCount: 1, rows: [{ '?column?': 1 }] };
      if (sql.includes('information_schema.columns')) {
        return { rowCount: requiredColumns.length, rows: requiredColumns.map((column_name) => ({ column_name })) };
      }
      if (sql.includes("to_regclass('public.idx_exam_submissions_idempotency_key')")) {
        return { rowCount: 1, rows: [{ available: true }] };
      }
      if (sql.includes('FROM public.ai_tutor_usage_daily')) {
        return {
          rowCount: 1,
          rows: [{ requests: '0', successes: '0', no_hints: '0', not_found: '0', failures: '0', rate_limited: '0', invalid_requests: '0', latency_total: '0', latency_max: 0, provider_cost_microusd: '0' }],
        };
      }
      if (sql.includes('FROM public.ai_response_reports')) return { rowCount: 1, rows: [{ reports: 0 }] };
      throw new Error(`Unexpected health query: ${sql}`);
    },
  };
  const redis = {
    async get() { return staffId; },
    async checkHealth() { return { status: 'healthy', latencyMs: 2 }; },
  };
  const app = Fastify({ logger: false });
  app.decorate('db', db as any);
  app.decorate('redisService', redis as any);
  await app.register(jwt, { secret: 'admin-health-test-only-secret' });
  await app.register(managementRoutes, { db: db as any, redis: redis as any });
  await app.ready();

  const oldSupabaseUrl = process.env.SUPABASE_URL;
  const oldPublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL = 'https://auth.example.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'health-test-publishable-key';

  try {
    const token = app.jwt.sign({
      userId: staffId,
      email: 'health-test@example.test',
      role: 'super_admin',
      sessionId: randomUUID(),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/management/health',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.services.database, 'healthy');
    assert.equal(body.services.redis, 'healthy');
    assert.equal(body.services.candidateIdentityVerification, 'configured');
    assert.equal(body.services.examSubmissionStorage, 'ready');
    assert.equal(body.services.liveExamRanking, 'healthy');
    assert.equal(body.submissionReadiness.status, 'ready');
    assert.equal(body.submissionReadiness.mode, 'read_only_dependency_probe');
    assert.equal(body.submissionReadiness.idempotencyIndex, 'available');
    assert.deepEqual(body.submissionReadiness.missingColumns, []);
    assert.match(body.submissionReadiness.note, /does not contact Supabase Auth or submit a test exam/);
    assert.equal(body.aiTutor.configured, false);
    assert.equal(body.aiTutorUsage.provider, 'none');
    assert.equal(body.databasePool.total, 3);
    assert.equal(databaseWrites, 0, 'Health checks must not write to the database');
  } finally {
    if (oldSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = oldSupabaseUrl;
    if (oldPublishableKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = oldPublishableKey;
    await app.close();
  }
}

void testHealthEndpointReportsReadOnlySubmissionReadiness().then(
  () => console.log('Admin health endpoint readiness and no-write checks passed.'),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
