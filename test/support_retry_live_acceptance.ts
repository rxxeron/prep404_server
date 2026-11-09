import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import Redis from 'ioredis';
import { Pool } from 'pg';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const adminKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !adminKey || !publicKey || !process.env.DATABASE_URL || !process.env.REDIS_URL) {
    throw new Error('Required live QA environment is unavailable.');
  }

  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('supabase.com') ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 8000 });
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, connectTimeout: 3000, maxRetriesPerRequest: 1, retryStrategy: () => null });
  redis.on('error', () => {});
  let userId: string | null = null;
  let requestId: string | null = null;
  let rateLimitKey: string | null = null;
  let results: Record<string, unknown> = {};

  try {
    await redis.connect();
    assert.equal(await redis.ping(), 'PONG');
    const email = `qa-support-retry-${randomUUID()}@example.invalid`;
    const password = randomBytes(32).toString('base64url');
    const createResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: adminKey, Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { codex_qa: 'support-retry-live' } }),
      signal: AbortSignal.timeout(15000),
    });
    const created = await createResponse.json() as { id?: string };
    if (!createResponse.ok || !created.id) throw new Error(`Temporary Auth creation failed (${createResponse.status}).`);
    userId = created.id;

    const signInResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: publicKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15000),
    });
    const session = await signInResponse.json() as { access_token?: string };
    if (!signInResponse.ok || !session.access_token) throw new Error(`Temporary Auth sign-in failed (${signInResponse.status}).`);

    const headers = { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' };
    const apiUrl = 'http://127.0.0.1:4040/api/v1';
    const onboarding = await fetch(`${apiUrl}/user/onboarding`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: randomUUID(),
        name: 'QA Support Retry',
        medium: 'english',
        academicBatch: '2026',
        institutionName: 'QA Test School',
        targetSelections: {},
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!onboarding.ok) throw new Error(`Temporary onboarding failed (${onboarding.status}).`);

    const payload = {
      category: 'learning_progress',
      subject: 'QA retry is safe',
      message: 'This disposable request verifies support retries over the live API.',
      idempotencyKey: randomUUID(),
    };
    const first = await fetch(`${apiUrl}/support/requests`, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    assert.equal(first.status, 201, `first support response status ${first.status}`);
    const firstBody = await first.json() as { request: { id: string } };
    requestId = firstBody.request.id;

    const retry = await fetch(`${apiUrl}/support/requests`, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    assert.equal(retry.status, 200, `retry response status ${retry.status}`);
    const retryBody = await retry.json() as { request: { id: string } };
    assert.equal(retryBody.request.id, requestId);

    const conflict = await fetch(`${apiUrl}/support/requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...payload, message: 'Changed request details require a fresh key.' }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(conflict.status, 409, `changed payload response status ${conflict.status}`);

    const userHash = createHash('sha256').update(userId).digest('hex');
    rateLimitKey = `ratelimit:support_request:${userHash}`;
    const before = await db.query(`SELECT
      (SELECT count(*)::int FROM public.learner_support_requests WHERE requester_id=$1::uuid AND idempotency_key=$2::uuid) AS cases,
      (SELECT count(*)::int FROM public.staff_audit_logs WHERE entity_id=$3::text AND action='support.request.created') AS audit_events`, [userId, payload.idempotencyKey, requestId]);
    assert.deepEqual(before.rows[0], { cases: 1, audit_events: 1 });
    const rateLimitValue = await redis.get(rateLimitKey);
    assert.equal(rateLimitValue, '1', 'identical retry and conflicting reuse must not consume the daily limit again');
    results = { live_http_statuses: [onboarding.status, first.status, retry.status, conflict.status], persisted_case_count: 1, audit_event_before_cleanup: 1, rate_limit_counter: 1 };
  } finally {
    if (userId) {
      const deletion = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { apikey: adminKey, Authorization: `Bearer ${adminKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!deletion.ok) throw new Error(`Exact disposable Auth cleanup failed (${deletion.status}).`);
      const keysDeleted = await redis.del(`profile:${userId}`, rateLimitKey ?? `ratelimit:support_request:${createHash('sha256').update(userId).digest('hex')}`);
      const remaining = await db.query(`SELECT
        (SELECT count(*)::int FROM auth.users WHERE id=$1::uuid) AS auth_users,
        (SELECT count(*)::int FROM public.users WHERE id=$1::uuid) AS profiles,
        (SELECT count(*)::int FROM public.learner_support_requests WHERE requester_id=$1::uuid) AS support_cases`, [userId]);
      assert.deepEqual(remaining.rows[0], { auth_users: 0, profiles: 0, support_cases: 0 });
      const audit = await db.query(`SELECT count(*)::int AS count FROM public.staff_audit_logs WHERE entity_id=$1::text AND action='support.request.created'`, [requestId]);
      assert.equal(audit.rows[0].count, 1, 'append-only support audit event must remain after exact learner cleanup');
      results = { ...results, cleaned_auth_profiles_support_cases: true, audit_event_after_cleanup: 1, exact_redis_keys_deleted: keysDeleted };
    }
    await db.end();
    redis.disconnect();
  }

  console.log(JSON.stringify(results));
}

void main().catch((error) => {
  console.error(`Live support retry acceptance failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
