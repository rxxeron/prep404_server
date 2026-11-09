require('dotenv').config({ path: 'server/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function verify() {
  const client = await pool.connect();
  try {
    const qCount = await client.query('SELECT COUNT(*) FROM questions');
    const exCount = await client.query('SELECT COUNT(*) FROM exams');
    const eqCount = await client.query('SELECT COUNT(*) FROM exam_questions');
    const appCount = await client.query('SELECT COUNT(*) FROM question_exam_appearances');
    const uniCount = await client.query('SELECT COUNT(*) FROM universities');

    console.log('=== LIVE DATABASE VERIFICATION ===');
    console.log('PostgreSQL Connected:', process.env.DATABASE_URL.replace(/:[^:]*@/, ':***@'));
    console.log('Universities in DB:        ', uniCount.rows[0].count);
    console.log('Questions in DB:           ', qCount.rows[0].count);
    console.log('Exams in DB:               ', exCount.rows[0].count);
    console.log('Exam-Question Mappings:    ', eqCount.rows[0].count);
    console.log('Question Appearances:      ', appCount.rows[0].count);

    console.log('\n--- Exams Breakdown by Exam Type ---');
    const exByType = await client.query(`
      SELECT exam_type, COUNT(*) as count 
      FROM exams 
      GROUP BY exam_type 
      ORDER BY count DESC
    `);
    console.table(exByType.rows);

    console.log('\n--- Questions & Exams by University ---');
    const qByUni = await client.query(`
      SELECT 
        u.short_name, 
        u.full_name, 
        COUNT(DISTINCT a.question_id) as total_questions, 
        COUNT(DISTINCT e.id) as total_exams
      FROM universities u
      LEFT JOIN question_exam_appearances a ON a.university_id::text = u.id::text
      LEFT JOIN exams e ON e.target_university_id::text = u.id::text
      GROUP BY u.id, u.short_name, u.full_name
      ORDER BY total_questions DESC
    `);
    console.table(qByUni.rows);

    console.log('\n--- Questions by Academic Subject (Direct DB count) ---');
    const qBySubj = await client.query(`
      SELECT 
        asub.name as subject, 
        COUNT(q.id) as questions_count
      FROM questions q
      LEFT JOIN academic_subjects asub ON q.subject_id = asub.id
      GROUP BY asub.name
      ORDER BY questions_count DESC
    `);
    console.table(qBySubj.rows);

    console.log('\n--- Recent Question Entries (Direct DB inspection) ---');
    const sampleQ = await client.query(`
      SELECT id, LEFT(stem_primary, 60) as stem, item_type, created_at 
      FROM questions 
      ORDER BY created_at DESC 
      LIMIT 3
    `);
    console.table(sampleQ.rows);

    console.log('\n--- Recent Exam Entries (Direct DB inspection) ---');
    const sampleEx = await client.query(`
      SELECT id, title, exam_type, total_marks, duration_seconds 
      FROM exams 
      ORDER BY created_at DESC 
      LIMIT 5
    `);
    console.table(sampleEx.rows);
  } finally {
    client.release();
    await pool.end();
  }
}

verify().catch(console.error);
