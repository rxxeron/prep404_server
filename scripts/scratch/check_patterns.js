const { Pool } = require('pg');
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || (() => { throw new Error('DATABASE_URL is not set'); })()),
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const r = await pool.query('SELECT exam_type, COUNT(*) FROM exams GROUP BY exam_type;');
  console.log(r.rows);
  const r2 = await pool.query('SELECT target_university_id, COUNT(*) FROM exams GROUP BY target_university_id;');
  console.log(r2.rows);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
