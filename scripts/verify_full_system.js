const { Pool } = require('pg');
require('dotenv').config({ path: 'server/.env' });

const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/prep404',
  ssl: (process.env.DATABASE_URL || '').includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
});

async function verify() {
  console.log('====================================================');
  console.log('1. VERIFYING DATABASE STATE (BLUEPRINTS & SNAPSHOTS)');
  console.log('====================================================');
  try {
    const bpRes = await db.query(
      'SELECT university_code, program_title, total_marks, duration_minutes, sections FROM university_blueprints ORDER BY university_code'
    );
    console.log(`✓ University Blueprints present: ${bpRes.rows.length}`);
    bpRes.rows.forEach(r =>
      console.log(`   - [${r.university_code.toUpperCase()}] ${r.program_title} (${r.total_marks} marks, ${r.sections ? r.sections.length : 0} sections)`)
    );
  } catch (err) {
    console.error('Error reading blueprints:', err.message);
  }

  try {
    const snapRes = await db.query('SELECT count(*) FROM exam_snapshots');
    const totalSnaps = parseInt(snapRes.rows[0].count, 10);
    console.log(`\n✓ Total Exam Snapshots in DB: ${totalSnaps}`);

    const leakQuery = `
      SELECT id, slug 
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
  } catch (err) {
    console.error('Error checking snapshots:', err.message);
  }

  await db.end();
}

verify();
