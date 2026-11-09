import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { examRoutes } from '../src/routes/exam.routes';
import { publicExamRoutes } from '../src/routes/public_exam.routes';

const examId = '20000000-0000-4000-8000-000000000001';
const sessionId = '30000000-0000-4000-8000-000000000001';

async function buildApp(plugin: typeof examRoutes | typeof publicExamRoutes, db: any, redis: any) {
  const app = Fastify({ logger: false });
  await app.register(plugin as any, { db, redis });
  await app.ready();
  return app;
}

async function testPublicStartFailsIfSessionTelemetryCannotPersist() {
  const calls: string[] = [];
  const db = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes('FROM public.exams')) return { rowCount: 1, rows: [{ id: examId }] };
      if (sql.includes('INSERT INTO public.exam_session_telemetry')) throw new Error('telemetry table unavailable');
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const app = await buildApp(publicExamRoutes, db, {});
  try {
    const response = await app.inject({ method: 'POST', url: `/api/v1/public/exam/${examId}/start` });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().sessionId, undefined);
    assert.match(response.json().error, /initialize an exam session/i);
    assert.equal(calls.length, 2);
  } finally {
    await app.close();
  }
}

async function testPublicSubmitRequiresRegisteredSession() {
  let sessionLookupCount = 0;
  const db = {
    async query(sql: string) {
      if (sql.includes('FROM exams WHERE id = $1::uuid')) return { rowCount: 1, rows: [{ id: examId, total_marks: 10 }] };
      if (sql.includes('FROM public.exam_session_telemetry')) {
        sessionLookupCount++;
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const app = await buildApp(publicExamRoutes, db, {});
  try {
    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/public/exam/${examId}/submit`,
      payload: { answers: {}, timeTakenSeconds: 900 },
    });
    assert.equal(missing.statusCode, 400);

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/v1/public/exam/${examId}/submit`,
      payload: { sessionId, answers: {}, timeTakenSeconds: 900 },
    });
    assert.equal(unknown.statusCode, 403);
    assert.match(unknown.json().error, /invalid or expired/i);
    assert.equal(sessionLookupCount, 1);
  } finally {
    await app.close();
  }
}

async function testPublicSubmitIgnoresClientClaimedTime() {
  const db = {
    async query(sql: string) {
      if (sql.includes('FROM exams WHERE id = $1::uuid')) {
        return { rowCount: 1, rows: [{ id: examId, total_marks: 10, negative_mark_per_question: 0.25 }] };
      }
      if (sql.includes('FROM public.exam_session_telemetry')) {
        return { rowCount: 1, rows: [{ elapsed_seconds: 1, submitted_at: null }] };
      }
      if (sql.includes('FROM exam_questions eq')) {
        return {
          rowCount: 10,
          rows: Array.from({ length: 10 }, (_, index) => ({
            id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            stem_primary: `Question ${index + 1}`,
            options: [{ key_original: 'A', text: 'Correct', is_correct: true }],
            solution_markdown: 'Explanation',
          })),
        };
      }
      if (sql.includes('UPDATE public.exam_session_telemetry')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const app = await buildApp(publicExamRoutes, db, {});
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/public/exam/${examId}/submit`,
      payload: { sessionId, answers: {}, timeTakenSeconds: 900 },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'SUSPICIOUS_SPEED');
  } finally {
    await app.close();
  }
}

async function testDynamicSubmitRequiresServerSession() {
  let databaseCalls = 0;
  const db = { async query() { databaseCalls++; throw new Error('Unexpected database call'); } };
  const redis = { async getSessionKey() { return null; } };
  const app = await buildApp(examRoutes, db, redis);
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/exam/${examId}/submit-session`,
      payload: {
        sessionId,
        answers: {},
        timeTakenSeconds: 900,
      },
    });
    assert.equal(response.statusCode, 403);
    assert.match(response.json().error, /invalid or expired/i);
    assert.equal(databaseCalls, 0);
  } finally {
    await app.close();
  }
}

async function testDynamicStartRemovesAnswerMapOnTelemetryFailure() {
  const storedKeys: string[] = [];
  const deletedKeys: string[] = [];
  const db = {
    async query(sql: string) {
      if (sql.includes('FROM exams e')) {
        return {
          rowCount: 1,
          rows: [{ id: examId, title: 'Test exam', track: 'engineering', durationMinutes: 30, totalMarks: 10, negativeMarking: 0.25, linkedQuestionCount: 1 }],
        };
      }
      if (sql.includes('FROM exam_questions eq')) {
        return {
          rowCount: 1,
          rows: [{ id: '40000000-0000-4000-8000-000000000001', order: 1, questionText: 'Test question', isActive: true, reviewStatus: 'approved', topicId: '40000000-0000-4000-8000-000000000002', solutionMarkdown: 'Explanation', options: [{ key_original: 'A', text: 'Correct', is_correct: true }, { key_original: 'B', text: 'Incorrect', is_correct: false }] }],
        };
      }
      if (sql.includes('INSERT INTO public.exam_session_telemetry')) throw new Error('telemetry table unavailable');
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const redis = {
    async setSessionKey(key: string) { storedKeys.push(key); },
    async del(key: string) { deletedKeys.push(key); return true; },
  };
  const app = await buildApp(examRoutes, db, redis);
  try {
    const response = await app.inject({ method: 'GET', url: `/api/v1/exam/${examId}/dynamic-session` });
    assert.equal(response.statusCode, 503);
    assert.match(response.json().error, /initialize an exam session/i);
    assert.equal(storedKeys.length, 2);
    assert.deepEqual(deletedKeys, storedKeys);
  } finally {
    await app.close();
  }
}

void (async () => {
  await testPublicStartFailsIfSessionTelemetryCannotPersist();
  await testPublicSubmitRequiresRegisteredSession();
  await testPublicSubmitIgnoresClientClaimedTime();
  await testDynamicSubmitRequiresServerSession();
  await testDynamicStartRemovesAnswerMapOnTelemetryFailure();
  console.log('Exam session telemetry, registration, and server-time checks passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
