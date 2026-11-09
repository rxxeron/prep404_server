const { Pool } = require('pg');
require('dotenv').config({ path: '.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const qCount = await pool.query("SELECT count(*) FROM questions");
    console.log("Total questions:", qCount.rows[0].count);

    const snapCount = await pool.query("SELECT count(*) FROM exam_snapshots");
    console.log("Total exam_snapshots:", snapCount.rows[0].count);

    const snapCols = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'exam_snapshots'");
    console.log("exam_snapshots columns:", snapCols.rows.map(r => r.column_name));
    const sample = await pool.query("SELECT * FROM exam_snapshots LIMIT 2");
    console.log("Sample snapshot:", sample.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
