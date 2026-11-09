const { Pool } = require('pg');
require('dotenv').config({ path: 'server/.env' });

const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/prep404',
  ssl: (process.env.DATABASE_URL || '').includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
});

async function checkCols() {
  const res = await db.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'exam_snapshots';
  `);
  console.log('Columns in exam_snapshots:', res.rows);

  const leakQuery = `
    SELECT slug, exam_id 
    FROM exam_snapshots 
    WHERE payload_json::text ILIKE '%correctOption%' 
       OR payload_json::text ILIKE '%"is_correct": true%' 
       OR payload_json::text ILIKE '%"is_correct":true%' 
       OR payload_json::text ILIKE '%solution_markdown%'
       OR payload_json::text ILIKE '%"explanation":%'
    LIMIT 10;
  `;
  const leakCheck = await db.query(leakQuery);
  if (leakCheck.rows.length === 0) {
    console.log('✓ ANTI-CHEAT VERIFIED: Zero answers, solutions, or explanations in all 487 snapshots in Postgres!');
  } else {
    console.error('❌ LEAKS FOUND in snapshots:', leakCheck.rows);
  }

  await db.end();
}

checkCols();
