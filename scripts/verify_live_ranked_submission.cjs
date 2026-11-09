const crypto = require('node:crypto');
const path = require('node:path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const Redis = require('ioredis');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const apiBase = process.env.LOCAL_API_BASE_URL || 'http://localhost:4040';
const apiUrl = new URL(apiBase);
if (process.argv[2] !== '--run' || !['localhost', '127.0.0.1', '::1'].includes(apiUrl.hostname)) {
  throw new Error('Run only against the local API with: node scripts/verify_live_ranked_submission.cjs --run');
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
  max: 1,
});
const redis = new Redis(process.env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
  enableOfflineQueue: false,
});

const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(pathname, options = {}) {
  const response = await fetch(new URL(pathname, apiBase), {
    ...options,
    signal: AbortSignal.timeout(15000),
  });
  let body = {};
  try { body = await response.json(); } catch { /* the caller still receives the HTTP status */ }
  return { response, body };
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
  try { result = await response.json(); } catch { /* DELETE may have no response body */ }
  return { response, body: result };
}

async function main() {
  let userId = null;
  let accessToken = null;
  let authUserCreated = false;
  let examId = null;
  let sessionId = null;
  let questionCount = 0;
  let name = null;
  let institution = null;
  let leaderboardMember = null;
  let accountDeleteVerified = false;
  let auditVerified = false;
  const cleanupErrors = [];
  const suffix = crypto.randomBytes(6).toString('hex');
  const email = `prep404-e2e-${suffix}@example.com`;
  const password = crypto.randomBytes(32).toString('base64url');
  name = `Prep404 QA ${suffix}`;
  institution = `Prep404 Temporary QA ${suffix}`;
  const spoofedUserId = uuid();

  try {
    const created = await supabaseAdmin('POST', '/auth/v1/admin/users', {
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name, test_account: true },
    });
    if (!created.response.ok || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(created.body.id || '')) {
      throw new Error(`Supabase temporary test-user creation failed (HTTP ${created.response.status}).`);
    }
    userId = created.body.id;
    authUserCreated = true;
    const priorProfile = await pool.query('SELECT 1 FROM public.users WHERE id=$1::uuid', [userId]);
    if (priorProfile.rowCount) throw new Error('Temporary auth identity already has a learner profile.');

    const signIn = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: publicKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15000),
    });
    const signInBody = await signIn.json().catch(() => ({}));
    if (!signIn.ok || !signInBody.access_token) throw new Error(`Temporary learner sign-in failed (HTTP ${signIn.status}).`);
    accessToken = signInBody.access_token;

    const authCheck = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: publicKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    });
    const authCheckBody = await authCheck.json().catch(() => ({}));
    if (!authCheck.ok || authCheckBody.id !== userId) {
      throw new Error(`Supabase access-token verification failed (HTTP ${authCheck.status}).`);
    }

    const onboarding = await api('/api/v1/user/onboarding', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: spoofedUserId,
        name,
        medium: 'english',
        academicBatch: '2026',
        institutionName: institution,
        targetSelections: {},
        track: 'private_uni',
      }),
    });
    if (!onboarding.response.ok || onboarding.body?.user?.id !== userId) {
      const reason = typeof onboarding.body?.error === 'string' ? onboarding.body.error : 'no error detail';
      throw new Error(`Onboarding identity binding failed (HTTP ${onboarding.response.status}: ${reason}).`);
    }

    const catalog = await api('/api/v1/exam/live?limit=200');
    if (!catalog.response.ok || !Array.isArray(catalog.body.exams)) throw new Error(`Live exam catalog failed (HTTP ${catalog.response.status}).`);
    const candidates = catalog.body.exams
      .filter((exam) => exam.isLiveNow && Number(exam.totalQuestions) > 0)
      .sort((a, b) => Number(a.totalQuestions) - Number(b.totalQuestions));
    let started = null;
    let skippedUnready = 0;
    for (const exam of candidates) {
      const attempt = await api(`/api/v1/exam/${encodeURIComponent(exam.id)}/dynamic-session`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (attempt.response.status === 404 || attempt.response.status === 409) {
        skippedUnready++;
        continue;
      }
      if (!attempt.response.ok || !attempt.body.sessionId || !Array.isArray(attempt.body.questions)) {
        throw new Error(`Dynamic exam session start failed (HTTP ${attempt.response.status}).`);
      }
      examId = exam.id;
      sessionId = attempt.body.sessionId;
      questionCount = attempt.body.questions.length;
      started = attempt;
      break;
    }
    if (!started) throw new Error(`No active exam passed readiness checks (${skippedUnready} unready candidates).`);
    if (!questionCount || started.body.questions.some((question) =>
      !Array.isArray(question.options) || question.options.some((option) => Object.hasOwn(option, 'is_correct')))) {
      throw new Error('The started exam payload was incomplete or exposed answer keys.');
    }
    const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
    const telemetryStart = await pool.query(
      'SELECT started_at FROM public.exam_session_telemetry WHERE exam_id=$1::uuid AND session_hash=$2',
      [examId, sessionHash],
    );
    if (!telemetryStart.rowCount) throw new Error('The started exam session was not persisted.');
    const sessionStartedAtMs = new Date(telemetryStart.rows[0].started_at).getTime();
    if (!Number.isFinite(sessionStartedAtMs)) throw new Error('The persisted session start time was invalid.');

    const mismatch = await api(`/api/v1/exam/${encodeURIComponent(examId)}/submit-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, userId: spoofedUserId, answers: {}, timeTakenSeconds: 900 }),
    });
    if (mismatch.response.status !== 403) throw new Error(`Mismatched learner identity was not denied (HTTP ${mismatch.response.status}).`);

    // Wait against Postgres time and compare the API clock before submitting.
    const requiredElapsedMs = (Math.max(3, questionCount * 0.5) + 15) * 1000;
    const waitDeadline = Date.now() + 90000;
    let databaseElapsedMs = 0;
    while (Date.now() < waitDeadline) {
      const elapsed = await pool.query(`SELECT EXTRACT(EPOCH FROM (clock_timestamp()-started_at))*1000 AS elapsed_ms
        FROM public.exam_session_telemetry WHERE exam_id=$1::uuid AND session_hash=$2`, [examId, sessionHash]);
      databaseElapsedMs = Number(elapsed.rows[0]?.elapsed_ms || 0);
      if (databaseElapsedMs >= requiredElapsedMs) break;
      await sleep(1000);
    }
    const healthBeforeSubmit = await api('/health');
    const backendTimeBeforeSubmit = Date.parse(healthBeforeSubmit.body?.timestamp || '');
    const backendElapsedMs = backendTimeBeforeSubmit - sessionStartedAtMs;
    const liveQuestionCount = await pool.query('SELECT COUNT(*)::int AS count FROM public.exam_questions WHERE exam_id=$1::uuid', [examId]);
    if (!healthBeforeSubmit.response.ok || !Number.isFinite(backendTimeBeforeSubmit) || databaseElapsedMs < requiredElapsedMs) {
      throw new Error('Postgres did not reach the minimum session age within 90 seconds.');
    }
    const submission = await api(`/api/v1/exam/${encodeURIComponent(examId)}/submit-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        answers: {},
        timeTakenSeconds: 1,
        candidateName: 'Client Spoof Must Not Persist',
        candidateInstitution: 'Client Spoof Institution',
        isPractice: false,
      }),
    });
    if (!submission.response.ok || submission.body.success !== true
      || submission.body.isPractice !== false || submission.body.submissionPersisted !== true
      || Number(submission.body.timeTakenSeconds) < Math.max(3, questionCount * 0.5)) {
      const reason = typeof submission.body?.error === 'string' ? submission.body.error : 'no error detail';
      const code = typeof submission.body?.code === 'string' ? `, ${submission.body.code}` : '';
      throw new Error(`Ranked submission failed validation (HTTP ${submission.response.status}${code}: ${reason}; `
        + `${questionCount} response questions, ${liveQuestionCount.rows[0]?.count} linked rows, `
        + `${Math.round(databaseElapsedMs)}ms database age, ${Math.round(backendElapsedMs)}ms backend age).`);
    }

    const persisted = await pool.query(`
      SELECT id, is_practice, score, correct_count, wrong_count, unanswered_count,
             time_taken_seconds, candidate_name, candidate_institution
      FROM public.exam_submissions
      WHERE exam_id=$1::uuid AND user_id=$2::uuid
      ORDER BY submitted_at DESC LIMIT 1`, [examId, userId]);
    if (!persisted.rowCount) throw new Error('Ranked submission was not persisted to Postgres.');
    const row = persisted.rows[0];
    if (row.is_practice !== false || Number(row.unanswered_count) !== questionCount
      || Number(row.time_taken_seconds) < Math.max(3, questionCount * 0.5)
      || row.candidate_name !== name || row.candidate_institution !== institution) {
      throw new Error('Persisted submission did not use the signed identity, profile, or server timing.');
    }
    const outcomeRows = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE outcome='skipped')::int AS skipped
      FROM public.exam_submission_answers WHERE submission_id=$1::uuid`, [row.id]);
    if (Number(outcomeRows.rows[0]?.total) !== questionCount || Number(outcomeRows.rows[0]?.skipped) !== questionCount) {
      throw new Error('Question-level skipped outcome snapshots did not all persist.');
    }

    leaderboardMember = `${name} (${institution})`;
    await redis.connect();
    const leaderboardKey = `leaderboard:exam:${examId}`;
    if (await redis.zscore(leaderboardKey, leaderboardMember) === null) {
      throw new Error('Ranked submission did not add the expected leaderboard member.');
    }

    const deletion = await api('/api/v1/user/account', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'technical_issues' }),
    });
    if (!deletion.response.ok || deletion.body.success !== true) {
      throw new Error(`Authenticated account deletion failed (HTTP ${deletion.response.status}).`);
    }
    accountDeleteVerified = true;

    const deletionResidual = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM auth.users WHERE id=$1::uuid) AS auth_users,
        (SELECT COUNT(*)::int FROM public.users WHERE id=$1::uuid) AS profiles,
        (SELECT COUNT(*)::int FROM public.exam_submissions WHERE user_id=$1::uuid) AS submissions`, [userId]);
    const remainingAtDeletion = Object.entries(deletionResidual.rows[0])
      .filter(([, count]) => Number(count) !== 0)
      .map(([table, count]) => `${table}=${count}`);
    if (remainingAtDeletion.length) {
      throw new Error(`The account-deletion API left temporary rows: ${remainingAtDeletion.join(', ')}.`);
    }

    const subjectHash = crypto.createHash('sha256').update(userId).digest('hex');
    const audit = await pool.query(`
      SELECT actor_email, entity_id, metadata FROM public.staff_audit_logs
      WHERE action='learner.account.deleted' AND entity_id=$1
      ORDER BY created_at DESC LIMIT 1`, [`deleted:${subjectHash}`]);
    const metadata = audit.rows[0]?.metadata;
    const serializedAudit = JSON.stringify({
      actor: audit.rows[0]?.actor_email,
      entity: audit.rows[0]?.entity_id,
      metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
    });
    const auditMetadata = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    auditVerified = audit.rowCount === 1
      && auditMetadata?.subjectHash === subjectHash
      && auditMetadata?.reason === 'technical_issues'
      && !serializedAudit.includes(userId)
      && !serializedAudit.includes(email);
    if (!auditVerified) throw new Error('Account-deletion audit was not minimized to reason and subject hash.');
  } finally {
    if (authUserCreated && userId) {
      try {
        const result = await supabaseAdmin('DELETE', `/auth/v1/admin/users/${encodeURIComponent(userId)}`);
        if (!result.response.ok && result.response.status !== 404) cleanupErrors.push(`Auth cleanup HTTP ${result.response.status}`);
      } catch { cleanupErrors.push('Supabase Auth cleanup failed'); }
    }

    try {
      if (userId) await pool.query('DELETE FROM public.users WHERE id=$1::uuid', [userId]);
      if (examId && sessionId) {
        const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
        await pool.query('DELETE FROM public.exam_session_telemetry WHERE exam_id=$1::uuid AND session_hash=$2', [examId, sessionHash]);
      }
    } catch { cleanupErrors.push('Postgres cleanup failed'); }

    try {
      if (redis.status === 'wait') await redis.connect();
      if (userId) await redis.del(`profile:${userId}`);
      if (examId && sessionId) {
        await redis.del(`session:${examId}:${sessionId}`, `session-owner:${examId}:${sessionId}`);
        if (leaderboardMember) {
          const leaderboardKey = `leaderboard:exam:${examId}`;
          await redis.zrem(leaderboardKey, leaderboardMember);
          if (await redis.zscore(leaderboardKey, leaderboardMember) !== null) cleanupErrors.push('Temporary leaderboard member remains');
        }
      }
      const residualRedisKeys = await redis.exists(
        ...(userId ? [`profile:${userId}`] : []),
        ...(examId && sessionId ? [`session:${examId}:${sessionId}`, `session-owner:${examId}:${sessionId}`] : []),
      );
      if (residualRedisKeys) cleanupErrors.push('Temporary learner or session Redis keys remain');
    } catch { cleanupErrors.push('Redis cleanup failed'); }

    try {
      if (userId) {
        const residual = await pool.query(`
          SELECT
            (SELECT COUNT(*)::int FROM auth.users WHERE id=$1::uuid) AS auth_users,
            (SELECT COUNT(*)::int FROM public.users WHERE id=$1::uuid) AS profiles,
            (SELECT COUNT(*)::int FROM public.exam_submissions WHERE user_id=$1::uuid) AS submissions,
            (SELECT COUNT(*)::int FROM public.exam_submission_answers a JOIN public.exam_submissions s ON s.id=a.submission_id WHERE s.user_id=$1::uuid) AS answer_snapshots,
            (SELECT COUNT(*)::int FROM public.exam_session_telemetry WHERE exam_id=$2::uuid AND session_hash=$3) AS sessions`, [
          userId,
          examId || '00000000-0000-0000-0000-000000000000',
          sessionId ? crypto.createHash('sha256').update(sessionId).digest('hex') : 'not-created',
        ]);
        if (Object.values(residual.rows[0]).some((count) => Number(count) !== 0)) cleanupErrors.push('Temporary learner or session rows remain');
      }
    } catch { cleanupErrors.push('Cleanup verification failed'); }

    await Promise.allSettled([pool.end(), redis.quit()]);
  }

  if (cleanupErrors.length) throw new Error(`E2E checks completed with cleanup failures: ${cleanupErrors.join('; ')}`);
  if (!accountDeleteVerified || !auditVerified) throw new Error('Live end-to-end acceptance checks did not complete.');
  console.log(JSON.stringify({
    onboardingIdentityBound: true,
    answerKeysHidden: true,
    spoofedSubmissionRejected: true,
    rankedSubmissionPersisted: true,
    serverTimingEnforced: true,
    questionOutcomesPersisted: questionCount,
    accountDeletionCompleted: true,
    deletionAuditMinimized: true,
    temporaryAuthProfileSubmissionAndSessionRemoved: true,
    temporaryLeaderboardMemberRemoved: true,
  }));
}

main().catch((error) => {
  // Never print test credentials, access tokens, learner IDs, or provider responses.
  console.error(error instanceof Error ? error.message : 'Live ranked submission verification failed.');
  process.exitCode = 1;
});
