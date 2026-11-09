const path = require('node:path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write('DATABASE_URL is unavailable.\n');
  process.exit(2);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 8_000,
});

const KPI_QUERY = `
  SELECT
    (SELECT count(*)::int
       FROM public.questions
      WHERE is_active = true AND review_status = 'approved') AS published_questions,
    (SELECT count(*)::int
       FROM public.questions q
      WHERE q.is_active = true
        AND q.review_status = 'approved'
        AND q.topic_id IS NOT NULL
        AND length(trim(COALESCE(q.stem_primary, ''))) >= 5
        AND length(trim(COALESCE(q.solution_markdown, ''))) >= 3
        AND CASE
          WHEN jsonb_typeof(q.options) = 'array' THEN
            jsonb_array_length(q.options) >= 2
            AND (SELECT count(*)
                   FROM jsonb_array_elements(q.options) AS option_item
                  WHERE COALESCE(option_item->>'is_correct', 'false') = 'true') = 1
          ELSE false
        END) AS exam_ready_questions,
    (SELECT count(*)::int FROM public.exams WHERE is_active = true) AS active_exams,
    (SELECT count(*)::int FROM public.exam_submissions WHERE is_practice = false) AS ranked_submissions,
    (SELECT count(*)::int
       FROM public.exam_submissions
      WHERE is_practice = false
        AND submitted_at >= now() - interval '30 days') AS ranked_submissions_30d`;

async function main() {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN READ ONLY');
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '8s'");
    const { rows } = await client.query(KPI_QUERY);
    await client.query('ROLLBACK');
    transactionOpen = false;
    process.stdout.write(`${JSON.stringify({ connected: true, kpis: rows[0] })}\n`);
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
        : 'read-only KPI query failed';
    process.stderr.write(`${JSON.stringify({ connected: false, code, reason })}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
