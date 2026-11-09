import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { examRoutes } from '../src/routes/exam.routes';
import { installSupabaseAuthStub, learnerToken } from './helpers/supabase_auth_stub';

const examId = '50000000-0000-4000-8000-000000000001';
const learnerOne = '50000000-0000-4000-8000-000000000002';
const learnerTwo = '50000000-0000-4000-8000-000000000003';
const submissionId = '50000000-0000-4000-8000-000000000004';
const tokenSecret = 'test-only-ranked-flow-jwt-secret';

function buildMocks(sessionAgeMs: number, questionSetReady = true, rankedInsertConflict = false) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const sessions = new Map<string, { examId: string; startedAt: Date; submittedAt: Date | null }>();
  const redisValues = new Map<string, string>();
  const rankedWrites: unknown[][] = [];
  const submissionWrites: unknown[][] = [];
  let completionWrites = 0;
  let rankWrites = 0;

  const questions = Array.from({ length: 10 }, (_, index) => ({
    id: `51000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    order: index + 1,
    stem_primary: `Question ${index + 1}`,
    questionText: `Question ${index + 1}`,
    isActive: true,
    reviewStatus: questionSetReady ? 'approved' : 'draft',
    topicId: '52000000-0000-4000-8000-000000000001',
    hasMath: false,
    subjectName: 'Mathematics',
    difficultyRating: 1,
    options: [
      { key_original: 'A', text: 'Correct option', is_correct: true },
      { key_original: 'B', text: 'Other option', is_correct: false },
    ],
    solution_markdown: 'Explanation',
    solutionMarkdown: 'Explanation',
  }));

  const db = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      // Postgres rejects statements whose $n placeholders and bound values
      // disagree; enforce the same rule here so mismatches fail the test.
      const placeholders = [...new Set((sql.match(/\$(\d+)/g) || []).map((p) => Number(p.slice(1))))].sort((a, b) => a - b);
      const highest = placeholders.length ? placeholders[placeholders.length - 1] : 0;
      assert.equal(highest, values.length, `Placeholder/value mismatch in: ${sql.trim().slice(0, 80)}`);
      assert.deepEqual(placeholders, Array.from({ length: highest }, (_, i) => i + 1), `Unreferenced parameter in: ${sql.trim().slice(0, 80)}`);
      if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql.trim())) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO mistake_vault')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO public.exam_session_telemetry')) {
        sessions.set(String(values[0]), {
          examId: String(values[1]),
          startedAt: new Date(Date.now() - sessionAgeMs),
          submittedAt: null,
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('FROM public.exam_session_telemetry')) {
        const session = sessions.get(String(values[0]));
        return session && session.examId === values[1]
          ? { rowCount: 1, rows: [{ started_at: new Date(Date.now() + 60_000), elapsed_seconds: Math.floor(sessionAgeMs / 1000), submitted_at: session.submittedAt }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes('UPDATE public.exam_session_telemetry SET submitted_at')) {
        const session = sessions.get(String(values[0]));
        if (session) session.submittedAt = new Date();
        completionWrites++;
        return { rowCount: session ? 1 : 0, rows: [] };
      }
      if (sql.includes('SELECT full_name, institution_name FROM public.users')) {
        const id = String(values[0]);
        return {
          rowCount: 1,
          rows: [{ full_name: id === learnerOne ? 'Learner One' : 'Learner Two', institution_name: 'Test College' }],
        };
      }
      if (sql.includes('FROM exams e') && sql.includes('WHERE e.id = $1::uuid')) {
        return {
          rowCount: 1,
          rows: [{ id: examId, title: 'Test Ranked Exam', track: 'engineering', durationMinutes: 60, totalMarks: 10, negativeMarking: 0.25, linkedQuestionCount: questions.length }],
        };
      }
      if (sql.includes('FROM exams WHERE id = $1::uuid')) {
        return {
          rowCount: 1,
          rows: [{ id: examId, title: 'Test Ranked Exam', track: 'engineering', duration_seconds: 3600, total_marks: 10, negative_mark_per_question: 0.25 }],
        };
      }
      if (sql.includes('FROM exam_questions eq')) return { rowCount: questions.length, rows: questions };
      if (sql.includes('FROM exam_submissions') && sql.includes('is_practice = false')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO exam_submissions')) {
        if (rankedInsertConflict && values[9] === false) {
          // Simulates a concurrent ranked submission winning the unique index.
          throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
        }
        submissionWrites.push(values);
        return { rowCount: 1, rows: [{ id: submissionId }] };
      }
      if (sql.includes('INSERT INTO public.exam_submission_answers')) return { rowCount: questions.length, rows: [] };
      if (sql.includes('INSERT INTO public.learner_analytics_events')) return { rowCount: 0, rows: [] };
      if (sql.startsWith('UPDATE exam_submissions SET rank=')) {
        rankWrites++;
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected database query: ${sql}`);
    },
  };
  // Transactions run on a pooled client that shares the same query handler.
  (db as any).connect = async () => ({ query: (sql: string, values?: unknown[]) => db.query(sql, values), release() {} });
  const redis = {
    async setSessionKey(key: string, value: string) { redisValues.set(key, value); },
    async getSessionKey(key: string) { return redisValues.get(key) ?? null; },
    async del(key: string) { return redisValues.delete(key); },
    async submitExamScore(...args: unknown[]) { rankedWrites.push(args); },
    async getUserExamRank() { return { rank: 1, totalCandidates: 1 }; },
    async getExamTotalParticipants() { return 1; },
    async recordQuestionTelemetry() {},
    async recordQuestionTelemetryBatch() {},
  };

  return {
    db,
    redis,
    calls,
    sessions,
    redisValues,
    rankedWrites,
    submissionWrites,
    get completionWrites() { return completionWrites; },
    get rankWrites() { return rankWrites; },
  };
}

async function createApp(mocks: ReturnType<typeof buildMocks>) {
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: tokenSecret });
  await app.register(examRoutes, { db: mocks.db as any, redis: mocks.redis as any });
  await app.ready();
  return app;
}

async function startSession(app: FastifyInstance, userId: string) {
  const token = learnerToken(userId);
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/exam/${examId}/dynamic-session`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  return { token, sessionId: response.json().sessionId as string, response: response.json() };
}

async function testServerSignedLearnerTokenIsRejected() {
  const mocks = buildMocks(120_000);
  const app = await createApp(mocks);
  try {
    // A token signed with the server's own JWT secret must not count as a
    // learner identity: only Supabase Auth can vouch for learners.
    const forged = app.jwt.sign({ userId: learnerOne });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/exam/${examId}/dynamic-session`,
      headers: { authorization: `Bearer ${forged}` },
    });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(mocks.sessions.size, 0, 'A rejected token must not start an exam session');
  } finally {
    await app.close();
  }
}

async function testSessionCannotBeRedeemedByAnotherLearner() {
  const mocks = buildMocks(15_000);
  const app = await createApp(mocks);
  try {
    const started = await startSession(app, learnerOne);
    const otherToken = learnerToken(learnerTwo);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/exam/${examId}/submit-session`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { sessionId: started.sessionId, answers: {}, timeTakenSeconds: 900 },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(mocks.submissionWrites.length, 0);
    const ownerKey = `session-owner:${examId}:${started.sessionId}`;
    assert.equal(mocks.redisValues.get(ownerKey), `user:${createHash('sha256').update(learnerOne).digest('hex')}`);
  } finally {
    await app.close();
  }
}

async function testRankedSubmissionUsesServerTimeAndPersists() {
  const mocks = buildMocks(60_000);
  const app = await createApp(mocks);
  try {
    const started = await startSession(app, learnerOne);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/exam/${examId}/submit-session`,
      headers: { authorization: `Bearer ${started.token}` },
      payload: { sessionId: started.sessionId, answers: {}, timeTakenSeconds: 900 },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.submissionPersisted, true);
    assert.equal(body.isPractice, false);
    assert.ok(body.timeTakenSeconds >= 45 && body.timeTakenSeconds <= 90);
    assert.notEqual(body.timeTakenSeconds, 900);
    assert.equal(mocks.submissionWrites.length, 1);
    assert.equal(Number(mocks.submissionWrites[0][7]), body.timeTakenSeconds);
    assert.equal(mocks.rankedWrites.length, 1);
    assert.equal(mocks.rankWrites, 1);
    assert.equal(mocks.completionWrites, 1);
  } finally {
    await app.close();
  }
}

async function testRankedRaceFallsBackToSavedPracticeAttempt() {
  const mocks = buildMocks(60_000, true, true);
  const app = await createApp(mocks);
  try {
    const started = await startSession(app, learnerOne);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/exam/${examId}/submit-session`,
      headers: { authorization: `Bearer ${started.token}` },
      payload: { sessionId: started.sessionId, answers: {}, timeTakenSeconds: 900 },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.isPractice, true, 'A lost ranking race is saved as practice');
    assert.equal(body.submissionPersisted, true);
    assert.equal(mocks.submissionWrites.length, 1, 'The fallback practice row is written once');
    assert.equal(mocks.rankedWrites.length, 0, 'Practice attempts never enter the live leaderboard');
  } finally {
    await app.close();
  }
}

async function testLeaderboardIsKeyedByLearnerNotName() {
  const mocks = buildMocks(60_000);
  const app = await createApp(mocks);
  try {
    const started = await startSession(app, learnerOne);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/exam/${examId}/submit-session`,
      headers: { authorization: `Bearer ${started.token}` },
      payload: { sessionId: started.sessionId, answers: {}, timeTakenSeconds: 900 },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(mocks.rankedWrites.length, 1);
    const [, member, displayName] = mocks.rankedWrites[0] as [string, string, string];
    assert.equal(member, `user:${learnerOne}`);
    assert.equal(displayName, 'Learner One (Test College)');
  } finally {
    await app.close();
  }
}

async function testDynamicStartRejectsUnreadyQuestionSetWithoutCreatingSession() {
  const mocks = buildMocks(15_000, false);
  const app = await createApp(mocks);
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/exam/${examId}/dynamic-session`,
    });

    assert.equal(response.statusCode, 409);
    assert.match(response.json().error, /question set is not ready/i);
    assert.equal(mocks.sessions.size, 0);
    assert.equal(mocks.redisValues.size, 0);
  } finally {
    await app.close();
  }
}

async function testLegacyRankedSubmitRequiresServerSession() {
  const mocks = buildMocks(60_000);
  const app = await createApp(mocks);
  try {
    const token = learnerToken(learnerOne);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/exam/${examId}/submit`,
      headers: { authorization: `Bearer ${token}` },
      payload: { answers: {}, timeTakenSeconds: 60 },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(mocks.submissionWrites.length, 0);
    assert.equal(mocks.rankedWrites.length, 0);

    const practiceResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/exam/${examId}/submit`,
      headers: { authorization: `Bearer ${token}` },
      payload: { answers: {}, timeTakenSeconds: 60, isPractice: true },
    });
    assert.equal(practiceResponse.statusCode, 200, practiceResponse.body);
    assert.equal(practiceResponse.json().isPractice, true);
    assert.equal(practiceResponse.json().submissionPersisted, true);
    assert.equal(mocks.submissionWrites.length, 1);
    assert.equal(mocks.rankedWrites.length, 0);
  } finally {
    await app.close();
  }
}

void (async () => {
  const restoreAuth = installSupabaseAuthStub();
  try {
  await testServerSignedLearnerTokenIsRejected();
  await testSessionCannotBeRedeemedByAnotherLearner();
  await testRankedSubmissionUsesServerTimeAndPersists();
  await testRankedRaceFallsBackToSavedPracticeAttempt();
  await testLeaderboardIsKeyedByLearnerNotName();
  await testLegacyRankedSubmitRequiresServerSession();
  await testDynamicStartRejectsUnreadyQuestionSetWithoutCreatingSession();
  } finally {
    restoreAuth();
  }
  console.log('Authenticated ranked exam session flow checks passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
