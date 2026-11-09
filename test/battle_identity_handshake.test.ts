import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RealBattleGateway } from '../src/battle/real_battle.gateway';

const verifiedLearnerId = '20000000-0000-4000-8000-000000000789';
const clientSuppliedId = '30000000-0000-4000-8000-000000000456';
const originalFetch = globalThis.fetch;
const originalEnvironment = {
  supabaseUrl: process.env.SUPABASE_URL,
  publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
  anonKey: process.env.SUPABASE_ANON_KEY,
};

class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly messages: any[] = [];
  closeCode: number | undefined;

  send(payload: string) { this.messages.push(JSON.parse(payload)); }
  close(code: number) { this.closeCode = code; this.readyState = 3; this.emit('close'); }
  async receive(payload: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function configureEnvironment() {
  process.env.SUPABASE_URL = 'https://supabase.example.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
}

function restoreEnvironment() {
  if (originalEnvironment.supabaseUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalEnvironment.supabaseUrl;
  if (originalEnvironment.publishableKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
  else process.env.SUPABASE_PUBLISHABLE_KEY = originalEnvironment.publishableKey;
  if (originalEnvironment.anonKey === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = originalEnvironment.anonKey;
}

async function testBattleRequiresVerifiedIdentityBeforeQueueing() {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db = { async query(sql: string, values: unknown[] = []) { queries.push({ sql, values }); return { rowCount: 0, rows: [] }; } };
  const gateway = new RealBattleGateway(db as any);
  const socket = new FakeSocket();
  gateway.handleConnection(socket as any);
  await socket.receive({ type: 'JOIN_QUEUE', userId: verifiedLearnerId });
  assert.equal(socket.messages[0]?.type, 'AUTH_ERROR');
  assert.equal(socket.closeCode, 4001);
  assert.equal(queries.length, 0, 'Unauthenticated sockets must not read learner profiles or enter queues');
}

async function testBattleUsesSupabaseIdentityAndDatabaseProfile() {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    async query(sql: string, values: unknown[] = []) {
      queries.push({ sql, values });
      if (sql.includes('FROM public.users WHERE id=$1::uuid')) {
        return { rowCount: 1, rows: [{ name: 'Verified Learner', college: 'Verified College' }] };
      }
      throw new Error(`Unexpected battle handshake query: ${sql.slice(0, 70)}`);
    },
  };
  const gateway = new RealBattleGateway(db as any);
  const socket = new FakeSocket();
  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return new Response(JSON.stringify({ id: verifiedLearnerId }), { status: 200 });
  }) as typeof fetch;
  gateway.handleConnection(socket as any);

  try {
    await socket.receive({ type: 'AUTHENTICATE', accessToken: 'synthetic-supabase-token' });
    assert.equal(socket.messages[0]?.type, 'AUTHENTICATED');
    assert.notEqual(socket.messages[0]?.publicId, verifiedLearnerId, 'Battle broadcasts must use a public reference');

    await socket.receive({ type: 'CREATE_ROOM', university: 'BRACU', program: 'eng', userId: clientSuppliedId, name: 'Forged Name', college: 'Forged College' });
    assert.equal(socket.messages[socket.messages.length - 1]?.type, 'ROOM_CREATED');
    assert.deepEqual(fetchCalls, ['https://supabase.example.test/auth/v1/user']);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].values[0], verifiedLearnerId, 'Profile reads must use the Auth-verified learner ID');
    assert.notEqual(queries[0].values[0], clientSuppliedId);
    const roomMessage = socket.messages.find((message) => message.type === 'ROOM_CREATED');
    assert.equal(roomMessage.university, 'BRACU');
    assert.equal(queries.some(({ sql }) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql)), false, 'Handshake and room creation must not persist battle data');
  } finally {
    socket.close(1000);
    globalThis.fetch = originalFetch;
  }
}

async function testInvalidSupabaseTokenCannotReadLearnerProfile() {
  const queries: string[] = [];
  const db = { async query(sql: string) { queries.push(sql); return { rowCount: 0, rows: [] }; } };
  const gateway = new RealBattleGateway(db as any);
  const socket = new FakeSocket();
  globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  gateway.handleConnection(socket as any);
  try {
    await socket.receive({ type: 'AUTHENTICATE', accessToken: 'invalid-supabase-token' });
    assert.equal(socket.messages[0]?.type, 'AUTH_ERROR');
    assert.equal(socket.closeCode, 4001);
    assert.equal(queries.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void (async () => {
  configureEnvironment();
  try {
    await testBattleRequiresVerifiedIdentityBeforeQueueing();
    await testBattleUsesSupabaseIdentityAndDatabaseProfile();
    await testInvalidSupabaseTokenCannotReadLearnerProfile();
    console.log('Battle socket identity handshake and no-write checks passed.');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment();
  }
})().catch((error) => {
  globalThis.fetch = originalFetch;
  restoreEnvironment();
  throw error;
});
