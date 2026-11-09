const path = require('node:path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write('DATABASE_URL is unavailable.\n');
  process.exit(2);
}

const requiredSubmissionColumns = [
  'exam_id', 'user_id', 'answers', 'score', 'correct_count', 'wrong_count', 'unanswered_count',
  'time_taken_seconds', 'rank', 'idempotency_key', 'is_practice', 'candidate_name',
  'candidate_institution', 'university_code', 'submitted_at',
];

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 8_000,
});

async function main() {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN READ ONLY');
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '8s'");
    const { rows } = await client.query(
      `SELECT
         ARRAY(SELECT column_name::text
                 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='exam_submissions'
                ORDER BY column_name) AS submission_columns,
         to_regclass('public.idx_exam_submissions_idempotency_key') IS NOT NULL AS idempotency_index,
         to_regclass('public.exam_session_telemetry') IS NOT NULL AS exam_session_telemetry,
         to_regclass('public.ai_tutor_usage_daily') IS NOT NULL AS ai_tutor_usage_daily,
         to_regclass('public.ai_response_reports') IS NOT NULL AS ai_response_reports`,
    );
    await client.query('ROLLBACK');
    transactionOpen = false;

    const result = rows[0];
    const availableColumns = new Set(result.submission_columns);
    const missingColumns = requiredSubmissionColumns.filter((column) => !availableColumns.has(column));
    const readiness = {
      submissionColumns: { required: requiredSubmissionColumns.length, missing: missingColumns },
      idempotencyIndex: result.idempotency_index,
      examSessionTelemetry: result.exam_session_telemetry,
      aiTutorUsageTables: {
        dailyUsage: result.ai_tutor_usage_daily,
        feedbackReports: result.ai_response_reports,
      },
      candidateIdentityConfigurationPresent: Boolean(
        process.env.SUPABASE_URL && (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY),
      ),
    };
    process.stdout.write(`${JSON.stringify({ connected: true, readiness })}\n`);
    if (missingColumns.length || !result.idempotency_index || !result.exam_session_telemetry || !result.ai_tutor_usage_daily || !result.ai_response_reports) {
      process.exitCode = 1;
    }
  } finally {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

main()
  .catch((error) => {
    const code = error?.code || null;
    const reason = code === 'ENOTFOUND'
      ? 'database host did not resolve'
      : code === 'ETIMEDOUT'
        ? 'database connection timed out'
        : 'read-only health-schema query failed';
    process.stderr.write(`${JSON.stringify({ connected: false, code, reason })}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
