const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config({ path: './server/.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function toDeterministicUuid(str) {
  const hash = crypto.createHash('sha1').update(str).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '5' + hash.substring(13, 16),
    ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.substring(18, 20),
    hash.substring(20, 32)
  ].join('-');
}

async function run() {
  const client = await pool.connect();
  try {
    console.log('Generating Topic Mastery Drill Exams...');

    // Fetch all subtopics with count of questions
    const subtopicsRes = await client.query(`
      SELECT st.id, st.name, st.slug, s.id as subject_id, s.name as subject_name, count(q.id) as question_count
      FROM academic_subtopics st
      JOIN academic_topics t ON st.topic_id = t.id
      JOIN academic_subjects s ON t.subject_id = s.id
      JOIN questions q ON q.subtopic_id = st.id
      GROUP BY st.id, st.name, st.slug, s.id, s.name
      HAVING count(q.id) >= 15
      ORDER BY count(q.id) DESC
    `);

    console.log(`Found ${subtopicsRes.rows.length} subtopics with >= 15 questions.`);

    const examsToInsert = [];
    const questionLinksToInsert = [];

    for (const st of subtopicsRes.rows) {
      const qCount = parseInt(st.question_count, 10);
      const examId = toDeterministicUuid(`topic_drill_${st.id}`);
      const title = `${st.name} - Topic Mastery Drill`;
      const numQuestions = Math.min(qCount, 25);
      const durationSeconds = numQuestions * 60; // 1 min per q

      examsToInsert.push({
        id: examId,
        title: title,
        track: 'GENERAL',
        exam_type: 'section_exam',
        duration_seconds: durationSeconds,
        total_marks: parseFloat(numQuestions.toFixed(1)),
        negative_mark_per_question: 0.25,
        is_active: true
      });

      // Get questions for this subtopic
      const qRes = await client.query(
        'SELECT id FROM questions WHERE subtopic_id = $1 ORDER BY difficulty_rating ASC, created_at DESC LIMIT 25',
        [st.id]
      );

      qRes.rows.forEach((row, idx) => {
        questionLinksToInsert.push({
          exam_id: examId,
          question_id: row.id,
          question_order: idx + 1
        });
      });
    }

    console.log(`Upserting ${examsToInsert.length} Topic Mastery Exams...`);

    // Bulk upsert exams
    for (const e of examsToInsert) {
      await client.query(`
        INSERT INTO exams (
          id, title, track, exam_type, duration_seconds,
          total_marks, negative_mark_per_question, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          duration_seconds = EXCLUDED.duration_seconds,
          total_marks = EXCLUDED.total_marks
      `, [
        e.id, e.title, e.track, e.exam_type, e.duration_seconds,
        e.total_marks, e.negative_mark_per_question, e.is_active
      ]);
    }

    console.log(`Inserting ${questionLinksToInsert.length} topic drill question links...`);
    // Batch insert question links
    const batchSize = 200;
    for (let i = 0; i < questionLinksToInsert.length; i += batchSize) {
      const batch = questionLinksToInsert.slice(i, i + batchSize);
      const placeholders = [];
      const values = [];

      batch.forEach((link, idx) => {
        const offset = idx * 3;
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
        values.push(link.exam_id, link.question_id, link.question_order);
      });

      await client.query(`
        INSERT INTO exam_questions (exam_id, question_id, question_order)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (exam_id, question_id) DO NOTHING
      `, values);
    }

    console.log('Topic Mastery Drill generation completed successfully!');

    const examCountRes = await client.query('SELECT exam_type, count(*) FROM exams GROUP BY exam_type');
    console.log('Updated Exams Breakdown:', examCountRes.rows);

    const totalLinksRes = await client.query('SELECT count(*) FROM exam_questions');
    console.log('Total exam_questions links:', totalLinksRes.rows[0].count);

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(console.error);
