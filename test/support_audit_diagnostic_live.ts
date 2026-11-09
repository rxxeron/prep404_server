import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { supportRoutes } from '../src/routes/support.routes';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const adminKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !adminKey || !publicKey || !process.env.DATABASE_URL) throw new Error('Live test env unavailable.');
  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('supabase.com') ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 8000 });
  let app: FastifyInstance | null = null;
  let userId: string | null = null;
  let requestId: string | null = null;
  let rateLimitCalls = 0;
  let diagnostics: Record<string, unknown> = {};
  try {
    const email = `qa-support-audit-${randomUUID()}@example.invalid`;
    const password = randomBytes(32).toString('base64url');
    const createdResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: adminKey, Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { codex_qa: 'support-audit-diagnostic' } }), signal: AbortSignal.timeout(15000) });
    const created = await createdResponse.json() as { id?: string };
    if (!createdResponse.ok || !created.id) throw new Error(`Auth create failed (${createdResponse.status}).`);
    userId = created.id;
    const signInResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: publicKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(15000) });
    const signedIn = await signInResponse.json() as { access_token?: string };
    if (!signInResponse.ok || !signedIn.access_token) throw new Error(`Auth sign-in failed (${signInResponse.status}).`);

    app = Fastify({ logger: false });
    await app.register(supportRoutes, { db, redis: { async checkRateLimit() { rateLimitCalls++; return { allowed: rateLimitCalls === 1, remaining: 0 }; } } as any });
    await app.ready();
    const payload = { category: 'learning_progress', subject: 'Support audit diagnostic', message: 'Disposable request checks audit lookup behavior.', idempotencyKey: randomUUID() };
    const headers = { authorization: `Bearer ${signedIn.access_token}` };
    const first = await app.inject({ method: 'POST', url: '/api/v1/support/requests', headers, payload });
    if (first.statusCode !== 201) throw new Error(`First request status ${first.statusCode}.`);
    requestId = first.json().request.id;
    const retry = await app.inject({ method: 'POST', url: '/api/v1/support/requests', headers, payload });
    const changed = await app.inject({ method: 'POST', url: '/api/v1/support/requests', headers, payload: { ...payload, message: 'Changed content must conflict under this key.' } });
    if (retry.statusCode !== 200 || retry.json().request.id !== requestId || changed.statusCode !== 409) throw new Error('Retry/conflict response invariant failed.');

    const actor = `learner:${createHash('sha256').update(userId).digest('hex').slice(0, 20)}`;
    const before = await db.query(`SELECT
      (SELECT count(*)::int FROM public.learner_support_requests WHERE requester_id=$1::uuid AND idempotency_key=$2::uuid) AS case_by_key,
      (SELECT count(*)::int FROM public.staff_audit_logs WHERE entity_id=$3::text AND action='support.request.created') AS audit_by_entity,
      (SELECT count(*)::int FROM public.staff_audit_logs WHERE actor_email=$4 AND action='support.request.created') AS audit_by_actor,
      (SELECT count(*)::int FROM public.staff_audit_logs WHERE entity_type='support_request' AND entity_id=$3::text) AS audit_by_entity_type`, [userId, payload.idempotencyKey, requestId, actor]);
    diagnostics = { response_codes: [first.statusCode, retry.statusCode, changed.statusCode], before_cleanup: before.rows[0], rate_limit_calls: rateLimitCalls };
  } finally {
    if (app) await app.close();
    if (userId) {
      const deletion = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: { apikey: adminKey, Authorization: `Bearer ${adminKey}` }, signal: AbortSignal.timeout(15000) });
      if (!deletion.ok) throw new Error(`Exact temporary Auth cleanup failed (${deletion.status}).`);
      const cleanup = await db.query(`SELECT
        (SELECT count(*)::int FROM auth.users WHERE id=$1::uuid) AS auth_users,
        (SELECT count(*)::int FROM public.users WHERE id=$1::uuid) AS profiles,
        (SELECT count(*)::int FROM public.learner_support_requests WHERE requester_id=$1::uuid) AS support_cases`, [userId]);
      const actor = `learner:${createHash('sha256').update(userId).digest('hex').slice(0, 20)}`;
      const after = await db.query(`SELECT
        (SELECT count(*)::int FROM public.staff_audit_logs WHERE entity_id=$1::text AND action='support.request.created') AS audit_by_entity,
        (SELECT count(*)::int FROM public.staff_audit_logs WHERE actor_email=$2 AND action='support.request.created') AS audit_by_actor`, [requestId, actor]);
      diagnostics = { ...diagnostics, cleanup: cleanup.rows[0], after_cleanup: after.rows[0] };
    }
    await db.end();
  }
  console.log(JSON.stringify(diagnostics));
}

void main().catch((error) => {
  console.error(`Audit diagnostic failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
