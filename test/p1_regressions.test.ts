import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { RedisService } from '../src/redis/redis.service';
import { publicExamRoutes } from '../src/routes/public_exam.routes';
import { questionRoutes } from '../src/routes/question.routes';
import { INTERNAL_ERROR_MESSAGE } from '../src/services/http_errors';
import { EventEmitter } from 'node:events';
import { BATTLE_MESSAGE_LIMIT, RealBattleGateway } from '../src/battle/real_battle.gateway';
import { installSupabaseAuthStub, learnerToken } from './helpers/supabase_auth_stub';

class FakeSocket extends EventEmitter {
  readyState = 1;
  messages: any[] = [];
  closeCode: number | undefined;
  send(raw: string) { this.messages.push(JSON.parse(raw)); }
  close(code: number) { if (this.readyState === 3) return; this.closeCode = code; this.readyState = 3; this.emit('close'); }
  async receive(payload: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const examId = '60000000-0000-4000-8000-000000000001';

async function withNodeEnv<T>(value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

function testLeaderboardOrdersByScoreThenTime() {
  const encode = RedisService.encodeLeaderboardScore;
  // Negative marking makes quarter scores common; a higher score must win
  // however slow it was (the old score + time-fraction encoding broke this).
  assert.ok(encode(45, 80_000) > encode(44.75, 10), '45.00 (slow) must outrank 44.75 (fast)');
  assert.ok(encode(30, 100) > encode(30, 101), 'Equal scores rank the faster attempt first');
  for (const score of [0, 0.25, 44.75, 45, 199.5]) {
    assert.equal(RedisService.decodeLeaderboardScore(encode(score, 1234)), score);
  }
  assert.ok(Number.isSafeInteger(encode(500, 0)), 'Encoded scores stay exact integers');
}

async function testLeaderboardMembersDoNotCollideOnName() {
  await withNodeEnv('development', async () => {
    const redis = new RedisService('redis://127.0.0.1:1');
    await redis.connect();
    await redis.submitExamScore(examId, 'user:a', 'Rahim (Dhaka College)', 40, 600);
    await redis.submitExamScore(examId, 'user:b', 'Rahim (Dhaka College)', 30, 600);
    const top = await redis.getTopExamRankers(examId, 10);
    assert.equal(top.length, 2, 'Two learners with the same name keep separate entries');
    assert.deepEqual(top.map((row) => row.score), [40, 30]);
    assert.equal(top[0].name, 'Rahim (Dhaka College)');
    assert.equal((await redis.getUserExamRank(examId, 'user:b')).rank, 2);
  });
}

async function testRedisFailsClosedInProduction() {
  await withNodeEnv('production', async () => {
    const redis = new RedisService('redis://127.0.0.1:1');
    await assert.rejects(redis.connect(), /Redis is required in production/);
    (redis as any).isConnected = true;
    await assert.rejects(redis.getSessionKey('anything'), 'A failed command must not silently use process memory');
  });
  await withNodeEnv('development', async () => {
    const redis = new RedisService('redis://127.0.0.1:1');
    await redis.connect();
    assert.equal(redis.isConnected, false, 'Development may fall back to the memory mirror');
  });
}

async function testInternalErrorsDoNotLeakDatabaseDetails() {
  const db = { async query() { throw new Error('relation "public.secret_table" does not exist'); } };
  const app = Fastify({ logger: false });
  await app.register(questionRoutes, { db: db as any, redis: {} as any });
  await app.ready();
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/questions' });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error, INTERNAL_ERROR_MESSAGE);
    assert.ok(!response.body.includes('secret_table'), 'Database error text must not reach the client');
    assert.ok(response.json().requestId, 'The response carries a request ID for support');
  } finally {
    await app.close();
  }
}

async function testPublicSubmissionIsIdempotent() {
  await withNodeEnv('development', async () => {
    const redis = new RedisService('redis://127.0.0.1:1');
    await redis.connect();
    let submissionsScored = 0;
    const db = {
      async query(sql: string) {
        if (sql.includes('FROM exams WHERE id = $1::uuid')) {
          return { rowCount: 1, rows: [{ id: examId, title: 'Public Mock', total_marks: 2, negative_mark_per_question: 0.25, duration_seconds: 3600 }] };
        }
        if (sql.includes('FROM public.exam_session_telemetry')) return { rowCount: 1, rows: [{ elapsed_seconds: 600, submitted_at: null }] };
        if (sql.includes('FROM exam_questions eq')) {
          submissionsScored++;
          return { rowCount: 2, rows: [
            { id: '61000000-0000-4000-8000-000000000001', stem_primary: 'Q1', options: [{ key_original: 'A', is_correct: true }, { key_original: 'B' }], solution_markdown: 'x' },
            { id: '61000000-0000-4000-8000-000000000002', stem_primary: 'Q2', options: [{ key_original: 'A' }, { key_original: 'B', is_correct: true }], solution_markdown: 'y' },
          ] };
        }
        if (sql.includes('UPDATE public.exam_session_telemetry')) return { rowCount: 1, rows: [] };
        throw new Error(`Unexpected query: ${sql.slice(0, 60)}`);
      },
    };
    const app = Fastify({ logger: false });
    await app.register(publicExamRoutes, { db: db as any, redis });
    await app.ready();
    try {
      const request = {
        method: 'POST' as const,
        url: `/api/v1/public/exam/${examId}/submit`,
        headers: { 'idempotency-key': `public-${randomUUID()}` },
        payload: { sessionId: randomUUID(), candidateName: 'Guest', candidateInstitution: 'College', answers: { '61000000-0000-4000-8000-000000000001': 'A' } },
      };
      const first = await app.inject(request);
      assert.equal(first.statusCode, 200, first.body);
      const second = await app.inject(request);
      assert.equal(second.statusCode, 200, second.body);
      assert.equal(second.headers['idempotency-replayed'], 'true', 'A retried public submission replays the stored result');
      assert.equal(submissionsScored, 1, 'The retry must not be scored a second time');
      assert.deepEqual(second.json(), first.json());
    } finally {
      await app.close();
    }
  });
}

async function testBattleSocketFloodIsCut() {
  const restore = installSupabaseAuthStub();
  try {
    const gateway = new RealBattleGateway({ async query() { return { rowCount: 0, rows: [] }; } } as any);
    const socket = new FakeSocket();
    gateway.handleConnection(socket as any);
    await socket.receive({ type: 'AUTHENTICATE', accessToken: learnerToken('62000000-0000-4000-8000-000000000002') });
    assert.equal(socket.messages[0]?.type, 'AUTHENTICATED');
    for (let i = 0; i < BATTLE_MESSAGE_LIMIT; i++) {
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'LEAVE_QUEUE' })));
    }
    assert.equal(socket.closeCode, 4008, 'A socket that floods messages is closed');
    assert.ok(socket.messages.some((m) => m.type === 'RATE_LIMITED'));
  } finally {
    restore();
  }
}

async function testSecondBattleConnectionReplacesFirst() {
  const restore = installSupabaseAuthStub();
  try {
    const learner = '62000000-0000-4000-8000-000000000001';
    const gateway = new RealBattleGateway({ async query() { return { rowCount: 0, rows: [] }; } } as any);
    const first = new FakeSocket();
    const second = new FakeSocket();
    gateway.handleConnection(first as any);
    gateway.handleConnection(second as any);
    await first.receive({ type: 'AUTHENTICATE', accessToken: learnerToken(learner) });
    assert.equal(first.messages[0]?.type, 'AUTHENTICATED');
    await second.receive({ type: 'AUTHENTICATE', accessToken: learnerToken(learner) });
    assert.equal(second.messages[0]?.type, 'AUTHENTICATED');
    assert.equal(first.closeCode, 4009, 'The older connection is closed when the learner reconnects');
    assert.equal(second.readyState, 1, 'The newer connection stays open');
  } finally {
    restore();
  }
}

void (async () => {
  testLeaderboardOrdersByScoreThenTime();
  await testBattleSocketFloodIsCut();
  await testSecondBattleConnectionReplacesFirst();
  await testLeaderboardMembersDoNotCollideOnName();
  await testRedisFailsClosedInProduction();
  await testInternalErrorsDoNotLeakDatabaseDetails();
  await testPublicSubmissionIsIdempotent();
  console.log('P1 regression checks passed (leaderboard, Redis fail-closed, error hygiene, public idempotency, battle limits).');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
