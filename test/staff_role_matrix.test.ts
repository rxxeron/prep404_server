import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { managementRoutes } from '../src/routes/management.routes';
import { questionManagementRoutes } from '../src/routes/question_management.routes';
import { battleModerationRoutes } from '../src/routes/battle_moderation.routes';
import { blueprintManagementRoutes } from '../src/routes/blueprint_management.routes';

type Role = 'setter' | 'moderator' | 'scheduler' | 'support' | 'super_admin';
const staffId = 'role-matrix-test-staff';
const STAFF_ROLES: Role[] = ['setter', 'moderator', 'scheduler', 'support', 'super_admin'];
const managementRoutePolicies: Array<{
  role: Role[];
  method: 'GET' | 'POST' | 'PUT';
  url: string;
}> = [
  { role: ['super_admin'], method: 'GET', url: '/api/v1/management/staff' },
  { role: ['super_admin'], method: 'POST', url: '/api/v1/management/staff' },
  { role: ['super_admin'], method: 'POST', url: '/api/v1/management/staff/:id/update' },
  { role: ['super_admin'], method: 'POST', url: '/api/v1/management/staff/:id/reset-password' },
  { role: ['moderator', 'super_admin'], method: 'GET', url: '/api/v1/management/questions/review-queue' },
  { role: ['moderator', 'super_admin'], method: 'GET', url: '/api/v1/management/question-reports' },
  { role: ['moderator', 'super_admin'], method: 'GET', url: '/api/v1/management/ai-response-reports' },
  { role: ['moderator', 'super_admin'], method: 'POST', url: '/api/v1/management/ai-response-reports/:id/review' },
  { role: ['moderator', 'super_admin'], method: 'POST', url: '/api/v1/management/question-reports/:id/resolve' },
  { role: ['moderator', 'super_admin'], method: 'POST', url: '/api/v1/management/questions/:id/review' },
  { role: ['setter', 'moderator', 'scheduler', 'super_admin'], method: 'GET', url: '/api/v1/management/coverage' },
  { role: ['support', 'super_admin'], method: 'GET', url: '/api/v1/management/support/learners/lookup?phone=01700000000' },
  { role: ['support', 'super_admin'], method: 'GET', url: '/api/v1/management/support/cases' },
  { role: ['support', 'super_admin'], method: 'POST', url: '/api/v1/management/support/requests/:id/status' },
  { role: ['support', 'super_admin'], method: 'POST', url: '/api/v1/management/support/cases' },
  { role: ['support', 'super_admin'], method: 'POST', url: '/api/v1/management/support/cases/:id/status' },
  { role: ['setter', 'moderator', 'scheduler', 'super_admin'], method: 'GET', url: '/api/v1/management/analytics/learning' },
  { role: ['super_admin'], method: 'GET', url: '/api/v1/management/audit-log' },
  { role: ['super_admin'], method: 'GET', url: '/api/v1/management/health' },
  { role: ['scheduler', 'super_admin'], method: 'GET', url: '/api/v1/management/exam-incidents' },
  { role: ['scheduler', 'super_admin'], method: 'POST', url: '/api/v1/management/exam-incidents/:id/status' },
  { role: ['scheduler', 'super_admin'], method: 'POST', url: '/api/v1/management/exams/:slug/incidents' },
  { role: ['setter', 'moderator', 'scheduler', 'super_admin'], method: 'GET', url: '/api/v1/management/question-targets' },
  { role: ['setter', 'moderator', 'scheduler', 'super_admin'], method: 'GET', url: '/api/v1/management/stats' },
  { role: ['setter', 'moderator', 'scheduler', 'super_admin'], method: 'GET', url: '/api/v1/management/questions' },
  { role: ['setter', 'moderator', 'super_admin'], method: 'PUT', url: '/api/v1/management/questions/:id' },
  { role: ['moderator', 'super_admin'], method: 'GET', url: '/api/v1/management/questions/:id/history' },
  { role: ['setter', 'moderator', 'super_admin'], method: 'POST', url: '/api/v1/management/questions/create' },
  { role: ['setter', 'moderator', 'scheduler', 'super_admin'], method: 'GET', url: '/api/v1/management/exams/active' },
  { role: ['scheduler', 'super_admin'], method: 'GET', url: '/api/v1/management/exams/:slug/telemetry' },
  { role: ['setter', 'moderator', 'scheduler', 'super_admin'], method: 'GET', url: '/api/v1/management/exams/:slug/questions' },
  { role: ['scheduler', 'super_admin'], method: 'PUT', url: '/api/v1/management/exams/:slug' },
  { role: ['scheduler', 'super_admin'], method: 'POST', url: '/api/v1/management/exams/:slug/cancel' },
  { role: ['scheduler', 'super_admin'], method: 'POST', url: '/api/v1/management/exams/:slug/reschedule' },
  { role: ['scheduler', 'super_admin'], method: 'GET', url: '/api/v1/management/exams/:slug/export.csv' },
  { role: ['scheduler', 'super_admin'], method: 'POST', url: '/api/v1/management/exams/drafts' },
  { role: ['scheduler', 'super_admin'], method: 'POST', url: '/api/v1/management/exams/:slug/publish' },
  { role: ['scheduler', 'super_admin'], method: 'POST', url: '/api/v1/management/exams/deploy-daily' },
  { role: ['moderator', 'super_admin'], method: 'GET', url: '/api/v1/management/battle-reports' },
  { role: ['moderator', 'super_admin'], method: 'POST', url: '/api/v1/management/battle-reports/:id/review' },
  { role: ['setter', 'moderator', 'scheduler', 'super_admin'], method: 'GET', url: '/api/v1/management/blueprints' },
  { role: ['setter', 'scheduler', 'super_admin'], method: 'POST', url: '/api/v1/management/blueprints/generate-exam' },
  { role: ['setter', 'scheduler', 'super_admin'], method: 'POST', url: '/api/v1/management/daily-test/set' },
];

const managementRouteKey = (route: { method: string; url: string }) => `${route.method} ${route.url.split('?')[0]}`;
const requestUrlForPolicy = (url: string) => url
  .replaceAll(':id', '20000000-0000-4000-8000-000000000001')
  .replaceAll(':slug', 'matrix-test');

async function buildApp() {
  let databaseWrites = 0;
  const registeredManagementRoutes: string[] = [];
  const db = {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    async query(sql: string) {
      if (/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sql)) databaseWrites++;
      return { rowCount: 0, rows: [] };
    },
    async connect() {
      throw new Error('A role-matrix request must not connect to the database');
    },
  };
  const redis = { async get() { return staffId; } };
  const app = Fastify({ logger: false });
  app.addHook('onRoute', (routeOptions) => {
    const routeMethods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    const routeUrl = routeOptions.url;
    if (routeUrl.startsWith('/api/v1/management/')) {
      for (const method of routeMethods) {
        if (method !== 'HEAD') registeredManagementRoutes.push(`${method} ${routeUrl}`);
      }
    }
  });
  app.decorate('db', db as any);
  app.decorate('redisService', redis as any);
  await app.register(jwt, { secret: 'role-matrix-test-only-secret' });
  await app.register(managementRoutes, { db: db as any, redis: redis as any });
  await app.register(questionManagementRoutes, { db: db as any, redis: redis as any });
  await app.register(battleModerationRoutes, { db: db as any });
  await app.register(blueprintManagementRoutes, { db: db as any, redis: redis as any });
  await app.ready();
  return { app, getDatabaseWrites: () => databaseWrites, registeredManagementRoutes };
}

async function testRoleAllowsAndDenies() {
  const { app, getDatabaseWrites, registeredManagementRoutes } = await buildApp();
  assert.equal(managementRoutePolicies.length, 43, 'Every management route needs an explicit role policy');
  assert.deepEqual(
    registeredManagementRoutes.sort(),
    managementRoutePolicies.map(managementRouteKey).sort(),
    'The policy matrix must match every registered management route exactly',
  );
  const cases: Array<{ role: Role; method: 'GET' | 'POST' | 'PUT'; url: string; payload?: object; allowed: boolean }> = [
    { role: 'super_admin', method: 'GET', url: '/api/v1/management/staff', allowed: true },
    { role: 'support', method: 'GET', url: '/api/v1/management/staff', allowed: false },
    { role: 'setter', method: 'POST', url: '/api/v1/management/questions/create', payload: {}, allowed: true },
    { role: 'support', method: 'POST', url: '/api/v1/management/questions/create', payload: {}, allowed: false },
    { role: 'moderator', method: 'POST', url: '/api/v1/management/questions/20000000-0000-4000-8000-000000000001/review', payload: {}, allowed: true },
    { role: 'setter', method: 'POST', url: '/api/v1/management/questions/20000000-0000-4000-8000-000000000001/review', payload: {}, allowed: false },
    { role: 'scheduler', method: 'POST', url: '/api/v1/management/exams/drafts', payload: {}, allowed: true },
    { role: 'moderator', method: 'POST', url: '/api/v1/management/exams/drafts', payload: {}, allowed: false },
    { role: 'support', method: 'POST', url: '/api/v1/management/support/cases', payload: {}, allowed: true },
    { role: 'setter', method: 'POST', url: '/api/v1/management/support/cases', payload: {}, allowed: false },
    { role: 'moderator', method: 'POST', url: '/api/v1/management/battle-reports/20000000-0000-4000-8000-000000000001/review', payload: {}, allowed: true },
    { role: 'scheduler', method: 'POST', url: '/api/v1/management/battle-reports/20000000-0000-4000-8000-000000000001/review', payload: {}, allowed: false },
    // Deny checks cover each remaining sensitive route group. Guards must run
    // before any handler can read personal data or write operational records.
    { role: 'setter', method: 'POST', url: '/api/v1/management/staff', payload: {}, allowed: false },
    { role: 'moderator', method: 'POST', url: '/api/v1/management/staff/20000000-0000-4000-8000-000000000001/update', payload: {}, allowed: false },
    { role: 'scheduler', method: 'POST', url: '/api/v1/management/staff/20000000-0000-4000-8000-000000000001/reset-password', payload: {}, allowed: false },
    { role: 'support', method: 'GET', url: '/api/v1/management/questions/review-queue', allowed: false },
    { role: 'setter', method: 'GET', url: '/api/v1/management/question-reports', allowed: false },
    { role: 'scheduler', method: 'GET', url: '/api/v1/management/ai-response-reports', allowed: false },
    { role: 'support', method: 'POST', url: '/api/v1/management/ai-response-reports/20000000-0000-4000-8000-000000000001/review', payload: {}, allowed: false },
    { role: 'setter', method: 'POST', url: '/api/v1/management/question-reports/20000000-0000-4000-8000-000000000001/resolve', payload: {}, allowed: false },
    { role: 'support', method: 'GET', url: '/api/v1/management/coverage', allowed: false },
    { role: 'scheduler', method: 'GET', url: '/api/v1/management/support/learners/lookup?phone=01700000000', allowed: false },
    { role: 'setter', method: 'GET', url: '/api/v1/management/support/cases', allowed: false },
    { role: 'moderator', method: 'POST', url: '/api/v1/management/support/requests/20000000-0000-4000-8000-000000000001/status', payload: {}, allowed: false },
    { role: 'scheduler', method: 'POST', url: '/api/v1/management/support/cases/20000000-0000-4000-8000-000000000001/status', payload: {}, allowed: false },
    { role: 'support', method: 'GET', url: '/api/v1/management/analytics/learning', allowed: false },
    { role: 'moderator', method: 'GET', url: '/api/v1/management/audit-log', allowed: false },
    { role: 'support', method: 'GET', url: '/api/v1/management/health', allowed: false },
    { role: 'support', method: 'GET', url: '/api/v1/management/exam-incidents', allowed: false },
    { role: 'setter', method: 'POST', url: '/api/v1/management/exam-incidents/20000000-0000-4000-8000-000000000001/status', payload: {}, allowed: false },
    { role: 'setter', method: 'POST', url: '/api/v1/management/exams/20000000-0000-4000-8000-000000000001/incidents', payload: {}, allowed: false },
    { role: 'support', method: 'GET', url: '/api/v1/management/question-targets', allowed: false },
    { role: 'support', method: 'GET', url: '/api/v1/management/questions', allowed: false },
    { role: 'support', method: 'PUT', url: '/api/v1/management/questions/20000000-0000-4000-8000-000000000001', payload: {}, allowed: false },
    { role: 'setter', method: 'GET', url: '/api/v1/management/questions/20000000-0000-4000-8000-000000000001/history', allowed: false },
    { role: 'support', method: 'GET', url: '/api/v1/management/exams/active', allowed: false },
    { role: 'setter', method: 'POST', url: '/api/v1/management/exams/20000000-0000-4000-8000-000000000001/cancel', payload: {}, allowed: false },
    { role: 'setter', method: 'POST', url: '/api/v1/management/exams/20000000-0000-4000-8000-000000000001/reschedule', payload: {}, allowed: false },
    { role: 'moderator', method: 'GET', url: '/api/v1/management/exams/20000000-0000-4000-8000-000000000001/export.csv', allowed: false },
    { role: 'moderator', method: 'POST', url: '/api/v1/management/exams/drafts', payload: {}, allowed: false },
    { role: 'moderator', method: 'POST', url: '/api/v1/management/exams/20000000-0000-4000-8000-000000000001/publish', payload: {}, allowed: false },
    { role: 'support', method: 'GET', url: '/api/v1/management/blueprints', allowed: false },
    { role: 'moderator', method: 'POST', url: '/api/v1/management/blueprints/generate-exam', payload: {}, allowed: false },
    { role: 'moderator', method: 'POST', url: '/api/v1/management/daily-test/set', payload: {}, allowed: false },
    { role: 'scheduler', method: 'GET', url: '/api/v1/management/battle-reports', allowed: false },
  ];
  try {
    for (const item of cases) {
      const token = app.jwt.sign({
        userId: staffId,
        email: `${item.role}@example.test`,
        role: item.role,
        sessionId: randomUUID(),
      });
      const response = await app.inject({
        method: item.method,
        url: item.url,
        headers: { authorization: `Bearer ${token}` },
        payload: item.payload,
      });
      if (item.allowed) {
        assert.notEqual(response.statusCode, 401, `${item.role} should pass authentication for ${item.url}`);
        assert.notEqual(response.statusCode, 403, `${item.role} should be authorized for ${item.url}`);
      } else {
        assert.equal(response.statusCode, 403, `${item.role} should be denied for ${item.url}`);
      }
    }

    for (const route of managementRoutePolicies) {
      const requestUrl = requestUrlForPolicy(route.url);
      const anonymousResponse = await app.inject({ method: route.method, url: requestUrl, payload: {} });
      assert.equal(anonymousResponse.statusCode, 401, `Unauthenticated access must be denied for ${route.method} ${route.url}`);

      for (const role of STAFF_ROLES) {
        const token = app.jwt.sign({
          userId: staffId,
          email: `${role}@example.test`,
          role,
          sessionId: randomUUID(),
        });
        const response = await app.inject({
          method: route.method,
          url: requestUrl,
          headers: { authorization: `Bearer ${token}` },
          payload: {},
        });
        if (route.role.includes(role)) {
          assert.notEqual(response.statusCode, 401, `${role} should authenticate for ${route.method} ${route.url}`);
          assert.notEqual(response.statusCode, 403, `${role} should be authorized for ${route.method} ${route.url}`);
        } else {
          assert.equal(response.statusCode, 403, `${role} must be denied for ${route.method} ${route.url}`);
        }
      }
    }

    assert.equal(getDatabaseWrites(), 0, 'The role matrix must not write data');
  } finally {
    await app.close();
  }
}

void testRoleAllowsAndDenies().then(
  () => console.log('Staff role allow/deny matrix passed without database writes.'),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
