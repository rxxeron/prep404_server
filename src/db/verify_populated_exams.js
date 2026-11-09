const { Pool } = require('pg');
require('dotenv').config({ path: './server/.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function verify() {
  const byUniAndType = await pool.query(`
    SELECT 
      u.code as uni_code,
      e.exam_type,
      count(*) as exam_count,
      round(avg(e.total_marks)) as avg_marks,
      min(e.title) as sample_title
    FROM exams e
    JOIN universities u ON u.id = e.target_university_id
    GROUP BY u.code, e.exam_type
    ORDER BY u.code, e.exam_type;
  `);

  console.log('=== Exams by University and Type ===');
  console.table(byUniAndType.rows);

  // Sample a real exam and its questions
  const sampleRealExam = await pool.query(`
    SELECT e.id, e.title, e.track, e.exam_type, count(eq.question_id) as q_count
    FROM exams e
    JOIN exam_questions eq ON eq.exam_id = e.id
    WHERE e.exam_type = 'uni_exam' AND e.track = 'NSU'
    GROUP BY e.id, e.title, e.track, e.exam_type
    LIMIT 1;
  `);
  console.log('Sample NSU Real Exam:', sampleRealExam.rows[0]);

  const sampleQuestions = await pool.query(`
    SELECT eq.question_order, q.stem_primary, q.options
    FROM exam_questions eq
    JOIN questions q ON q.id = eq.question_id
    WHERE eq.exam_id = $1::uuid
    ORDER BY eq.question_order ASC
    LIMIT 3;
  `, [sampleRealExam.rows[0].id]);
  console.log('Sample Questions for NSU exam:');
  console.log(JSON.stringify(sampleQuestions.rows, null, 2));

  await pool.end();
}

verify().catch(console.error);
