const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const Redis = require('ioredis');
const WebSocket = require('ws');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const apiBase = process.env.LOCAL_API_BASE_URL || 'http://localhost:4041';
const apiUrl = new URL(apiBase);
if (process.argv[2] !== '--run' || !['localhost', '127.0.0.1', '::1'].includes(apiUrl.hostname)) {
  throw new Error('Run only against the local API with: node scripts/verify_live_battle_staff_e2e.cjs --run');
}
for (const key of ['DATABASE_URL', 'SUPABASE_URL', 'REDIS_URL']) {
  if (!process.env[key]) throw new Error(`Missing required server configuration: ${key}`);
}
if (!process.env.SUPABASE_PUBLISHABLE_KEY && !process.env.SUPABASE_ANON_KEY) {
  throw new Error('Missing required server configuration: SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY');
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SECRET_KEY) {
  throw new Error('Missing required server configuration: SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY');
}

const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const supabaseUrl = process.env.SUPABASE_URL.replace(/\/+$/, '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
  max: 2,
});
const redis = new Redis(process.env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
  enableOfflineQueue: false,
});

const uuid = () => crypto.randomUUID();
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const testPrefix = `prep404-e2e-${crypto.randomBytes(5).toString('hex')}`;
const testEmail = (suffix) => `${testPrefix}-${suffix}@example.com`;
const testName = (suffix) => `Prep404 QA ${testPrefix.slice(-8)} ${suffix}`;
const testPassword = () => crypto.randomBytes(32).toString('base64url');

const learners = [];
const staffAccounts = [];
const staffSessionIds = new Set();
const sockets = [];
const cleanupErrors = [];
let battleId = null;
let reportId = null;
let battleCompleted = false;
let reportResolved = false;
let staffLifecycleVerified = false;
let roleMatrixVerified = false;
let battleRounds = 0;
const roleMatrixRoles = new Set();

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(pathname, apiBase), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  let result = {};
  try { result = await response.json(); } catch { /* status is still available */ }
  return { response, body: result };
}

async function supabaseAdmin(method, pathname, body) {
  const response = await fetch(`${supabaseUrl}${pathname}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  let result = {};
  try { result = await response.json(); } catch { /* DELETE can be empty */ }
  return { response, body: result };
}

function decodePayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

function hashStaffPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

async function createLearner(suffix) {
  const email = testEmail(`learner-${suffix}`);
  const password = testPassword();
  const name = testName(`Learner ${suffix}`);
  const institution = `${testName('Institution')} ${suffix}`;
  const created = await supabaseAdmin('POST', '/auth/v1/admin/users', {
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name, test_account: true },
  });
  if (!created.response.ok || !created.body.id) {
    throw new Error(`Temporary Supabase learner creation failed (HTTP ${created.response.status}).`);
  }
  const learner = { id: created.body.id, email, password, name, institution, accessToken: null };
  learners.push(learner);

  const signIn = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: publicKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(15000),
  });
  const signInBody = await signIn.json().catch(() => ({}));
  if (!signIn.ok || !signInBody.access_token) throw new Error(`Temporary learner sign-in failed (HTTP ${signIn.status}).`);
  learner.accessToken = signInBody.access_token;

  const authCheck = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: publicKey, Authorization: `Bearer ${learner.accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  const authBody = await authCheck.json().catch(() => ({}));
  if (!authCheck.ok || authBody.id !== learner.id) throw new Error(`Temporary learner identity verification failed (HTTP ${authCheck.status}).`);

  const onboarding = await api('/api/v1/user/onboarding', {
    method: 'POST',
    token: learner.accessToken,
    body: {
      id: uuid(),
      name,
      medium: 'english',
      academicBatch: '2026',
      institutionName: institution,
      targetSelections: {},
      track: 'private_uni',
    },
  });
  if (!onboarding.response.ok || onboarding.body?.user?.id !== learner.id) {
    throw new Error(`Temporary learner onboarding failed (HTTP ${onboarding.response.status}).`);
  }
  return learner;
}

async function loginStaff(account, password = account.password) {
  const result = await api('/api/v1/staff/auth/login', {
    method: 'POST',
    body: { identifier: account.username, password },
  });
  if (!result.response.ok || !result.body.token || result.body.staff?.role !== account.role) {
    throw new Error(`Temporary managed staff sign-in failed (HTTP ${result.response.status}).`);
  }
  const payload = decodePayload(result.body.token);
  staffSessionIds.add(payload.sessionId);
  return { token: result.body.token, sessionId: payload.sessionId, role: payload.role };
}

async function verifyStaffLifecycle(actor) {
  const actorSession = await loginStaff(actor);
  const actorDirectory = await api('/api/v1/management/staff', { token: actorSession.token });
  if (!actorDirectory.response.ok || !Array.isArray(actorDirectory.body.staff)) {
    throw new Error(`Temporary super-admin directory access failed (HTTP ${actorDirectory.response.status}).`);
  }

  const target = staffAccounts.find((account) => account.username !== actor.username);
  const provision = await api('/api/v1/management/staff', {
    method: 'POST',
    token: actorSession.token,
    body: {
      email: target.email,
      username: target.username,
      fullName: target.fullName,
      role: 'setter',
      password: target.password,
    },
  });
  if (provision.response.status !== 201 || !provision.body.staff?.id || provision.body.staff.role !== 'setter') {
    throw new Error(`Live staff provisioning failed (HTTP ${provision.response.status}).`);
  }
  target.id = provision.body.staff.id;
  target.role = 'setter';

  let targetSession = await loginStaff(target);
  const denied = await api('/api/v1/management/staff', { token: targetSession.token });
  if (denied.response.status !== 403) throw new Error(`Non-admin staff directory access returned HTTP ${denied.response.status}, expected 403.`);

  const roleChange = await api(`/api/v1/management/staff/${target.id}/update`, {
    method: 'POST', token: actorSession.token, body: { role: 'moderator' },
  });
  if (!roleChange.response.ok || roleChange.body.requiresReauthentication !== true) {
    throw new Error(`Live staff role change returned HTTP ${roleChange.response.status} (reauth=${String(roleChange.body.requiresReauthentication)}, role=${String(roleChange.body.staff?.role)}).`);
  }
  const staleRoleSession = await api('/api/v1/management/battle-reports', { token: targetSession.token });
  if (staleRoleSession.response.status !== 401) throw new Error('Role change did not revoke the prior staff session.');
  target.role = 'moderator';
  targetSession = await loginStaff(target);

  const oldPassword = target.password;
  const resetPassword = testPassword();
  const reset = await api(`/api/v1/management/staff/${target.id}/reset-password`, {
    method: 'POST', token: actorSession.token, body: { password: resetPassword },
  });
  if (!reset.response.ok || reset.body.requiresReauthentication !== true) throw new Error('Live staff password reset failed.');
  const stalePasswordSession = await api('/api/v1/management/battle-reports', { token: targetSession.token });
  if (stalePasswordSession.response.status !== 401) throw new Error('Password reset did not revoke the prior staff session.');
  const oldPasswordLogin = await api('/api/v1/staff/auth/login', { method: 'POST', body: { identifier: target.username, password: oldPassword } });
  if (oldPasswordLogin.response.status !== 401) throw new Error('The prior staff password remained valid after reset.');
  target.password = resetPassword;
  targetSession = await loginStaff(target);

  const disabled = await api(`/api/v1/management/staff/${target.id}/update`, {
    method: 'POST', token: actorSession.token, body: { isActive: false },
  });
  if (!disabled.response.ok || disabled.body.staff?.isActive !== false) throw new Error('Live staff disablement failed.');
  const disabledSession = await api('/api/v1/management/battle-reports', { token: targetSession.token });
  if (disabledSession.response.status !== 401) throw new Error('Disabled staff account retained a working session.');
  const disabledLogin = await api('/api/v1/staff/auth/login', { method: 'POST', body: { identifier: target.username, password: target.password } });
  if (disabledLogin.response.status !== 401) throw new Error('Disabled staff account could still sign in.');

  const enabled = await api(`/api/v1/management/staff/${target.id}/update`, {
    method: 'POST', token: actorSession.token, body: { isActive: true },
  });
  if (!enabled.response.ok || enabled.body.staff?.isActive !== true) throw new Error('Live staff re-enablement failed.');
  targetSession = await loginStaff(target);

  const setterRole = await api(`/api/v1/management/staff/${target.id}/update`, {
    method: 'POST', token: actorSession.token, body: { role: 'setter' },
  });
  if (!setterRole.response.ok) throw new Error('Live staff role could not be changed to setter.');
  const staleSetterSession = await api('/api/v1/management/questions', { token: targetSession.token });
  if (staleSetterSession.response.status !== 401) throw new Error('Setter role change did not revoke the prior staff session.');
  target.role = 'setter';
  targetSession = await loginStaff(target);
  await verifyRoleMatrix('setter', targetSession.token);
  const setterLogout = await api('/api/v1/staff/auth/logout', { method: 'POST', token: targetSession.token });
  if (!setterLogout.response.ok) throw new Error('Live staff sign-out failed.');
  const revokedLogoutSession = await api('/api/v1/management/questions', { token: targetSession.token });
  if (revokedLogoutSession.response.status !== 401) throw new Error('Staff sign-out did not revoke the exact session.');

  const moderatorRole = await api(`/api/v1/management/staff/${target.id}/update`, {
    method: 'POST', token: actorSession.token, body: { role: 'moderator' },
  });
  if (!moderatorRole.response.ok) throw new Error('Live staff role could not be changed back to moderator.');
  target.role = 'moderator';
  targetSession = await loginStaff(target);

  staffLifecycleVerified = true;
  return { actorSession, targetSession, target };
}

function makeSocket(accessToken) {
  const wsBase = apiBase.replace(/^http/, 'ws');
  const socket = new WebSocket(`${wsBase}/ws/battle`);
  sockets.push(socket);
  const messages = [];
  const waiters = [];
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });
  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const waitFor = (type, extra = () => true, timeoutMs = 25000) => {
    const predicate = (message) => message.type === type && extra(message);
    const queuedIndex = messages.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(messages.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timeout: null };
      waiter.timeout = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for battle event ${type}.`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  const send = (payload) => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Battle socket is not open.');
    socket.send(JSON.stringify(payload));
  };
  const authenticated = (async () => {
    await opened;
    const received = waitFor('AUTHENTICATED', () => true, 10000);
    send({ type: 'AUTHENTICATE', accessToken });
    const result = await received;
    if (!result.publicId) throw new Error('Battle authentication omitted the public player ID.');
  })();
  return { socket, send, waitFor, authenticated };
}

async function completeDuel(firstLearner, secondLearner) {
  const programs = await api('/api/v1/battle/university-programs');
  const bracu = programs.body?.data?.find((university) => university.code === 'BRACU');
  if (!programs.response.ok || !bracu?.patterns?.some((pattern) => pattern.slug === 'eng')) {
    throw new Error('The live BRACU engineering battle pattern is unavailable.');
  }

  const [first, second] = [makeSocket(firstLearner.accessToken), makeSocket(secondLearner.accessToken)];
  await Promise.all([first.authenticated, second.authenticated]);
  const roomCreated = first.waitFor('ROOM_CREATED');
  first.send({ type: 'CREATE_ROOM', university: 'BRACU', program: 'eng' });
  const room = await roomCreated;
  if (!room.roomCode) throw new Error('Private battle room did not return a room code.');

  const matchFirst = first.waitFor('MATCH_FOUND');
  const matchSecond = second.waitFor('MATCH_FOUND');
  second.send({ type: 'JOIN_ROOM', roomCode: room.roomCode });
  const [matchA, matchB] = await Promise.all([matchFirst, matchSecond]);
  battleId = matchA.roomId || matchB.roomId || null;
  if (!battleId || battleId !== matchB.roomId || Number(matchA.totalRounds) < 1) {
    throw new Error('Live duel did not start with a persisted room and at least one question.');
  }
  const totalRounds = Number(matchA.totalRounds);
  battleRounds = totalRounds;

  for (let round = 1; round <= totalRounds; round++) {
    const startA = first.waitFor('ROUND_START', (event) => event.roundIndex === round);
    const startB = second.waitFor('ROUND_START', (event) => event.roundIndex === round);
    const [roundA, roundB] = await Promise.all([startA, startB]);
    const question = roundA.question;
    if (!question?.options?.length || Object.hasOwn(question, 'correctOption')
      || question.options.some((option) => Object.hasOwn(option, 'is_correct') || Object.hasOwn(option, 'isCorrect'))) {
      throw new Error('Battle round exposed an answer key or had no playable options.');
    }
    if (roundA.question.id !== roundB.question.id) throw new Error('Battle players received different questions for the same round.');
    const optionId = question.options[0].id;
    first.send({ type: 'SUBMIT_ANSWER', roomId: battleId, optionId, timeRemainingSeconds: 999 });
    second.send({ type: 'SUBMIT_ANSWER', roomId: battleId, optionId, timeRemainingSeconds: 999 });
    const [resultA, resultB] = await Promise.all([
      first.waitFor('ROUND_RESULT', (event) => event.roundIndex === round),
      second.waitFor('ROUND_RESULT', (event) => event.roundIndex === round),
    ]);
    if (resultA.roundIndex !== resultB.roundIndex) throw new Error('Battle results were inconsistent between players.');
  }

  const [finishedA, finishedB] = await Promise.all([
    first.waitFor('DUEL_FINISHED', () => true, 10000),
    second.waitFor('DUEL_FINISHED', () => true, 10000),
  ]);
  if (!finishedA || !finishedB) throw new Error('Both learners did not receive duel completion.');

  let roomRecord = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await pool.query(`SELECT status, player_ids FROM public.battle_rooms WHERE id=$1::uuid`, [battleId]);
    roomRecord = result.rows[0] || null;
    if (roomRecord?.status === 'finished') break;
    await sleep(500);
  }
  const actualPlayers = (roomRecord?.player_ids || []).map(String).sort();
  const expectedPlayers = [firstLearner.id, secondLearner.id].sort();
  if (roomRecord?.status !== 'finished' || JSON.stringify(actualPlayers) !== JSON.stringify(expectedPlayers)) {
    throw new Error('The completed duel was not durably stored with the signed learner identities.');
  }
  battleCompleted = true;
  return { first, second, totalRounds };
}

async function verifyRoleMatrix(role, token) {
  const source = fs.readFileSync(path.resolve(__dirname, '../test/staff_role_matrix.test.ts'), 'utf8');
  const policies = [...source.matchAll(/\{\s*role:\s*\[([^\]]*)\],\s*method:\s*'(GET|POST|PUT)',\s*url:\s*'([^']+)'/g)]
    .map((match) => ({
      roles: [...match[1].matchAll(/'([a-z_]+)'/g)].map((role) => role[1]),
      method: match[2],
      url: match[3],
    }));
  if (policies.length !== 41) throw new Error(`Live role verifier found ${policies.length} policies; expected 41.`);

  const testAuditEmails = staffAccounts.map((account) => account.email).filter(Boolean);
  const before = await pool.query(`SELECT COUNT(*)::int AS count FROM public.staff_audit_logs WHERE actor_email=ANY($1::text[])`, [testAuditEmails]);
  let anonymousChecks = 0;
  let roleChecks = 0;
  for (const policy of policies) {
    const route = policy.url.replaceAll(':id', '20000000-0000-4000-8000-000000000001').replaceAll(':slug', 'matrix-test');
    const anonymous = await api(route, { method: policy.method, body: policy.method === 'GET' ? undefined : {} });
    if (anonymous.response.status !== 401) throw new Error(`Anonymous management route was HTTP ${anonymous.response.status} for ${policy.method} ${policy.url}.`);
    anonymousChecks++;

    const result = await api(route, { method: policy.method, token, body: policy.method === 'GET' ? undefined : {} });
    const allowed = policy.roles.includes(role);
    if (allowed ? [401, 403].includes(result.response.status) : result.response.status !== 403) {
      throw new Error(`Live ${role} role mismatch for ${policy.method} ${policy.url} (HTTP ${result.response.status}).`);
    }
    roleChecks++;
  }
  const after = await pool.query(`SELECT COUNT(*)::int AS count FROM public.staff_audit_logs WHERE actor_email=ANY($1::text[])`, [testAuditEmails]);
  if (Number(after.rows[0].count) !== Number(before.rows[0].count)) {
    throw new Error('The live role matrix produced an unexpected staff audit write.');
  }
  if (anonymousChecks !== 41 || roleChecks !== 41) throw new Error(`Live ${role} role matrix covered ${roleChecks}/41 routes.`);
  roleMatrixRoles.add(role);
}

async function main() {
  const suffix = testPrefix.slice(-8);
  const staffActor = {
    id: uuid(),
    email: testEmail('admin'),
    username: `qa_${suffix}_admin`,
    fullName: testName('Temporary Admin'),
    password: testPassword(),
    role: 'super_admin',
  };
  const staffTarget = {
    email: testEmail('moderator'),
    username: `qa_${suffix}_moderator`,
    fullName: testName('Temporary Moderator'),
    password: testPassword(),
    role: 'setter',
  };
  staffAccounts.push(staffActor, staffTarget);

  try {
    const adminCount = await pool.query(`SELECT COUNT(*)::int AS count FROM public.staff_members WHERE role='super_admin' AND is_active=true`);
    if (Number(adminCount.rows[0].count) < 1) throw new Error('A live super-admin must remain active during this test.');
    const currentHealth = await api('/health');
    if (!currentHealth.response.ok) throw new Error(`Local API health failed (HTTP ${currentHealth.response.status}).`);

    await Promise.all([createLearner('a'), createLearner('b')]);
    await pool.query(`INSERT INTO public.staff_members (id,email,username,password_hash,full_name,role,is_active,session_version)
      VALUES ($1::uuid,lower($2),$3,$4,$5,'super_admin',true,1)`, [
      staffActor.id, staffActor.email, staffActor.username, hashStaffPassword(staffActor.password), staffActor.fullName,
    ]);

    const lifecycle = await verifyStaffLifecycle(staffActor);
    const moderatorSession = lifecycle.targetSession;
    await verifyRoleMatrix('moderator', moderatorSession.token);
    roleMatrixVerified = roleMatrixRoles.has('setter') && roleMatrixRoles.has('moderator');

    const duel = await completeDuel(learners[0], learners[1]);
    const report = await api('/api/v1/battle/reports', {
      method: 'POST',
      token: learners[0].accessToken,
      body: { battleId, category: 'other', details: 'Temporary moderation workflow QA.' },
    });
    if (report.response.status !== 201 || !report.body.id) throw new Error(`Live battle report submission failed (HTTP ${report.response.status}).`);
    reportId = report.body.id;

    const queue = await api('/api/v1/management/battle-reports?status=open&limit=100', { token: moderatorSession.token });
    const queuedReport = queue.body.reports?.find((item) => item.id === reportId);
    if (!queue.response.ok || queuedReport?.status !== 'open') throw new Error('Moderator could not find the temporary battle report in the live queue.');

    const resolution = await api(`/api/v1/management/battle-reports/${reportId}/review`, {
      method: 'POST', token: moderatorSession.token,
      body: { status: 'resolved', note: 'Resolved after temporary QA verification.' },
    });
    if (!resolution.response.ok || resolution.body.success !== true) throw new Error(`Moderator could not resolve the temporary battle report (HTTP ${resolution.response.status}).`);
    const resolvedQueue = await api('/api/v1/management/battle-reports?status=resolved&limit=100', { token: moderatorSession.token });
    if (!resolvedQueue.response.ok || !resolvedQueue.body.reports?.some((item) => item.id === reportId && item.status === 'resolved')) {
      throw new Error('Resolved battle report was not visible in the live moderator queue.');
    }
    const persistedReport = await pool.query(`SELECT status, reviewed_by FROM public.battle_reports WHERE id=$1::uuid`, [reportId]);
    if (persistedReport.rows[0]?.status !== 'resolved' || persistedReport.rows[0]?.reviewed_by !== lifecycle.target.email) {
      throw new Error('Battle report resolution was not persisted with the signed moderator identity.');
    }
    reportResolved = true;
  } finally {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        try { socket.close(1000, 'QA cleanup'); } catch { /* cleanup continues */ }
      }
    }
    await Promise.allSettled(sockets.map((socket) => new Promise((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      const timeout = setTimeout(resolve, 1500);
      socket.once('close', () => { clearTimeout(timeout); resolve(); });
    })));

    try {
      if (reportId) await pool.query('DELETE FROM public.battle_reports WHERE id=$1::uuid', [reportId]);
      if (battleId) await pool.query('DELETE FROM public.battle_reports WHERE battle_id=$1::uuid', [battleId]);
      if (battleId) await pool.query('DELETE FROM public.battle_rooms WHERE id=$1::uuid', [battleId]);
      const ids = learners.map((learner) => learner.id);
      if (ids.length) {
        await pool.query('DELETE FROM public.learner_analytics_events WHERE user_id=ANY($1::uuid[])', [ids]);
        await pool.query('DELETE FROM public.learner_analytics_consent WHERE user_id=ANY($1::uuid[])', [ids]);
      }
    } catch { cleanupErrors.push('Postgres battle/profile cleanup failed'); }

    for (const learner of learners) {
      try {
        const deleted = await supabaseAdmin('DELETE', `/auth/v1/admin/users/${encodeURIComponent(learner.id)}`);
        if (!deleted.response.ok && deleted.response.status !== 404) cleanupErrors.push(`Learner Auth cleanup HTTP ${deleted.response.status}`);
      } catch { cleanupErrors.push('Supabase learner cleanup failed'); }
    }
    try {
      const ids = learners.map((learner) => learner.id);
      if (ids.length) await pool.query('DELETE FROM public.users WHERE id=ANY($1::uuid[])', [ids]);
      const emails = staffAccounts.map((account) => account.email).filter(Boolean);
      const usernames = staffAccounts.map((account) => account.username).filter(Boolean);
      const foundStaff = await pool.query(`SELECT id FROM public.staff_members
        WHERE lower(email)=ANY($1::text[]) OR username=ANY($2::text[])`, [emails, usernames]);
      const staffIds = [...new Set([
        ...staffAccounts.map((account) => account.id).filter(Boolean),
        ...foundStaff.rows.map((row) => String(row.id)),
      ])];
      if (staffIds.length) await pool.query('DELETE FROM public.staff_members WHERE id=ANY($1::uuid[])', [staffIds]);
    } catch { cleanupErrors.push('Postgres identity cleanup failed'); }

    try {
      if (redis.status === 'wait') await redis.connect();
      const keys = [];
      for (const learner of learners) {
        keys.push(`profile:${learner.id}`, `ratelimit:battle_report:${hash(learner.id)}`);
      }
      for (const sessionId of staffSessionIds) keys.push(`staff:session:${hash(sessionId)}`);
      const identifiers = staffAccounts.flatMap((account) => [account.username, account.email].filter(Boolean));
      for (const identifier of identifiers) {
        for (const ip of ['127.0.0.1', '::1']) keys.push(`ratelimit:staff-login:${hash(`${identifier.toLowerCase()}|${ip}`)}`);
      }
      if (keys.length) await redis.del(...keys);
      if (keys.length && await redis.exists(...keys)) cleanupErrors.push('Temporary identity Redis keys remain');
    } catch { cleanupErrors.push('Redis test-data cleanup failed'); }

    try {
      const learnerIds = learners.map((learner) => learner.id);
      const staffIds = staffAccounts.map((account) => account.id).filter(Boolean);
      const staffEmails = staffAccounts.map((account) => account.email).filter(Boolean);
      const staffUsernames = staffAccounts.map((account) => account.username).filter(Boolean);
      const residual = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM auth.users WHERE id=ANY($1::uuid[])) AS auth_users,
          (SELECT COUNT(*)::int FROM public.users WHERE id=ANY($1::uuid[])) AS profiles,
          (SELECT COUNT(*)::int FROM public.battle_rooms WHERE id=$2::uuid) AS rooms,
          (SELECT COUNT(*)::int FROM public.battle_reports WHERE ($3::uuid IS NOT NULL AND id=$3::uuid) OR ($2::uuid IS NOT NULL AND battle_id=$2::uuid)) AS reports,
          (SELECT COUNT(*)::int FROM public.staff_members WHERE id=ANY($4::uuid[]) OR lower(email)=ANY($5::text[]) OR username=ANY($6::text[])) AS staff_accounts,
          (SELECT COUNT(*)::int FROM public.staff_members WHERE role='super_admin' AND is_active=true) AS active_super_admins,
          (SELECT COUNT(*)::int FROM public.learner_analytics_events WHERE user_id=ANY($1::uuid[])) AS learner_events,
          (SELECT COUNT(*)::int FROM public.learner_analytics_consent WHERE user_id=ANY($1::uuid[])) AS analytics_consent`, [
        learnerIds.length ? learnerIds : [uuid()],
        battleId,
        reportId,
        staffIds.length ? staffIds : [uuid()],
        staffEmails,
        staffUsernames,
      ]);
      if (Number(residual.rows[0].active_super_admins) < 1
        || Object.entries(residual.rows[0]).some(([key, count]) => key !== 'active_super_admins' && Number(count) !== 0)) {
        cleanupErrors.push('Temporary Supabase, learner, battle, staff, or analytics rows remain');
      }
    } catch { cleanupErrors.push('Final live cleanup verification failed'); }

    await Promise.allSettled([pool.end(), redis.quit()]);
  }

  if (cleanupErrors.length) throw new Error(`Live test cleanup failed: ${cleanupErrors.join('; ')}`);
  if (!battleCompleted || !reportResolved || !staffLifecycleVerified || !roleMatrixVerified) {
    throw new Error('Live battle, report, staff lifecycle, or role-matrix acceptance checks did not complete.');
  }
  console.log(JSON.stringify({
    authenticatedBattleCompleted: battleCompleted,
    battleRounds,
    answerKeysHiddenDuringRounds: true,
    battleResultPersisted: true,
    learnerReportCreated: true,
    moderatorQueueAndResolutionVerified: reportResolved,
    staffProvisionRoleChangeDisableResetAndRevocationVerified: staffLifecycleVerified,
    liveManagementRoleChecks: { anonymous: 41, setter: 41, moderator: 41 },
    temporarySupabaseLearnerAndManagedStaffRowsRemoved: true,
    temporaryBattleAndRedisRowsRemoved: true,
    appendOnlyTestAuditRowsRetained: true,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Live battle and staff verification failed.');
  process.exitCode = 1;
});
