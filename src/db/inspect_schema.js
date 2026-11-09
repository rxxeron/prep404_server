const { Pool } = require('pg');
require('dotenv').config({ path: './.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const tables = ['questions', 'universities', 'programs', 'academic_units', 'academic_subjects', 'exams', 'exam_questions', 'users', 'institutions'];
  for (const t of tables) {
    const res = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [t]
    );
    console.log(`\n=== TABLE: ${t} ===`);
    res.rows.forEach(r => console.log(`  ${r.column_name}: ${r.data_type}`));
    const countRes = await pool.query(`SELECT count(*) FROM "${t}"`);
    console.log(`  TOTAL ROWS: ${countRes.rows[0].count}`);
  }
  await pool.end();
}

run().catch(console.error);
