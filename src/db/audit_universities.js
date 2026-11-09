const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const client = await pool.connect();
  try {
    const unis = await client.query('SELECT id, code, short_name FROM universities ORDER BY code');
    console.log('=== University Breakdown ===');

    for (const u of unis.rows) {
      const qCount = await client.query(
        'SELECT count(DISTINCT question_id) FROM question_exam_appearances WHERE university_id = $1',
        [u.id]
      );
      const examBreakdown = await client.query(
        'SELECT exam_type, count(*) FROM exams WHERE target_university_id = $1 GROUP BY exam_type',
        [u.id]
      );
      const examTitles = await client.query(
        'SELECT title, exam_type FROM exams WHERE target_university_id = $1 ORDER BY title LIMIT 4',
        [u.id]
      );
      const totalExamQuestions = await client.query(
        'SELECT count(eq.question_id) FROM exams e JOIN exam_questions eq ON eq.exam_id = e.id WHERE e.target_university_id = $1',
        [u.id]
      );

      console.log(`\nUniversity: ${u.code} (${u.short_name})`);
      console.log(`  Questions in appearances: ${qCount.rows[0].count}`);
      console.log(`  Total mapped questions in exams: ${totalExamQuestions.rows[0].count}`);
      console.log(`  Exams by type:`, examBreakdown.rows);
      console.log(`  Sample Exams:`, examTitles.rows.map(x => `[${x.exam_type}] ${x.title}`));
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(console.error);
