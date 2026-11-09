require('dotenv').config({ path: 'server/.env' });
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SECRET_SALT = process.env.API_SIGNATURE_SECRET || 'prep404-secure-slug-salt-2026';

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function buildSnapshots() {
  const client = await pool.connect();
  try {
    console.log('Fetching all active exams...');
    const examsRes = await client.query(`
      SELECT 
        e.id, 
        e.title, 
        e.exam_type, 
        e.track, 
        e.duration_seconds, 
        e.total_marks, 
        e.negative_mark_per_question,
        u.code as uni_code
      FROM exams e
      LEFT JOIN universities u ON u.id = e.target_university_id
      WHERE e.is_active = true
      ORDER BY e.created_at ASC
    `);

    const exams = examsRes.rows;
    console.log(`Found ${exams.length} active exams to snapshot.`);

    const usedSlugs = new Set();
    let insertedCount = 0;

    for (let i = 0; i < exams.length; i++) {
      const exam = exams[i];
      
      // 1. Generate unique human-readable slug
      let baseSlug = slugify(exam.title);
      if (!baseSlug || baseSlug.length < 3) {
        baseSlug = `exam-${exam.id.slice(0, 8)}`;
      }
      let finalSlug = baseSlug;
      let counter = 1;
      while (usedSlugs.has(finalSlug)) {
        finalSlug = `${baseSlug}-${counter++}`;
      }
      usedSlugs.add(finalSlug);

      // 2. Generate secure obfuscated token (to prevent direct out-of-app URL guessing)
      const accessKey = 'qs_' + crypto
        .createHmac('sha256', SECRET_SALT)
        .update(`${exam.id}:${finalSlug}`)
        .digest('hex')
        .slice(0, 24);

      // 3. Fetch linked questions in exact question_order
      const qRes = await client.query(`
        SELECT 
          eq.question_order,
          q.id,
          q.stem_primary,
          (q.stem_primary LIKE '%$%' OR q.stem_primary LIKE '%\\%') AS has_math,
          q.options,
          q.difficulty_rating
        FROM exam_questions eq
        JOIN questions q ON q.id = eq.question_id
        WHERE eq.exam_id = $1::uuid AND q.is_active = true
        ORDER BY eq.question_order ASC
      `, [exam.id]);

      const questions = qRes.rows.map((row, idx) => {
        const rawOpts = Array.isArray(row.options) ? row.options : [];
        const options = rawOpts.map((opt, oIdx) => {
          const key = opt.key_original || String.fromCharCode(65 + oIdx);
          return {
            id: key,
            text: opt.text || ''
          };
        });

        return {
          id: row.id,
          order: row.question_order || idx + 1,
          questionText: row.stem_primary,
          hasMath: !!row.has_math,
          options,
          difficultyRating: parseFloat(row.difficulty_rating || '1.0')
        };
      });

      const payloadJson = {
        examId: exam.id,
        slug: finalSlug,
        accessKey,
        title: exam.title,
        examType: exam.exam_type,
        track: exam.track || (exam.uni_code || 'General'),
        durationMinutes: Math.round((exam.duration_seconds || 1800) / 60),
        totalMarks: parseFloat(exam.total_marks || 50),
        negativeMark: parseFloat(exam.negative_mark_per_question || 0.25),
        questionCount: questions.length,
        questions
      };

      const payloadHash = crypto.createHash('md5').update(JSON.stringify(payloadJson)).digest('hex');

      // 4. Upsert into exam_snapshots
      await client.query(`
        INSERT INTO exam_snapshots (
          exam_id,
          slug,
          access_key,
          title,
          exam_type,
          track,
          duration_minutes,
          total_marks,
          negative_mark,
          question_count,
          payload_json,
          payload_hash,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        ON CONFLICT (exam_id) DO UPDATE SET
          slug = EXCLUDED.slug,
          access_key = EXCLUDED.access_key,
          title = EXCLUDED.title,
          exam_type = EXCLUDED.exam_type,
          track = EXCLUDED.track,
          duration_minutes = EXCLUDED.duration_minutes,
          total_marks = EXCLUDED.total_marks,
          negative_mark = EXCLUDED.negative_mark,
          question_count = EXCLUDED.question_count,
          payload_json = EXCLUDED.payload_json,
          payload_hash = EXCLUDED.payload_hash,
          version = exam_snapshots.version + 1,
          updated_at = NOW()
      `, [
        exam.id,
        finalSlug,
        accessKey,
        exam.title,
        exam.exam_type,
        exam.track || (exam.uni_code || 'General'),
        payloadJson.durationMinutes,
        payloadJson.totalMarks,
        payloadJson.negativeMark,
        questions.length,
        JSON.stringify(payloadJson),
        payloadHash
      ]);

      insertedCount++;
      if (insertedCount % 50 === 0 || insertedCount === exams.length) {
        console.log(`Compiled ${insertedCount}/${exams.length} exam snapshots...`);
      }
    }

    console.log(`\nSuccessfully compiled and stored ${insertedCount} exam snapshots in database!`);

    // Verify sample
    const sample = await client.query(`
      SELECT slug, access_key, title, exam_type, question_count, duration_minutes 
      FROM exam_snapshots 
      LIMIT 5
    `);
    console.log('\nSample compiled snapshots:');
    console.table(sample.rows);
  } finally {
    client.release();
    await pool.end();
  }
}

buildSnapshots().catch(err => {
  console.error('Snapshot build failed:', err);
  process.exit(1);
});
