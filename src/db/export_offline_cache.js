const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

function sanitizeOptions(options) {
  const rawOpts = Array.isArray(options) ? options : [];
  return rawOpts.map((opt, idx) => {
    const clean = typeof opt === 'object' && opt !== null ? { ...opt } : {};
    delete clean.is_correct;
    delete clean.isCorrect;
    return {
      ...clean,
      id: clean.key_original || clean.id || String.fromCharCode(65 + idx),
      text: clean.text || '',
    };
  });
}

async function exportOfflineCache() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  console.log('Connected to PostgreSQL database for offline cache export...');

  try {
    // 1. Fetch universities
    const uniRes = await client.query(`
      SELECT id, code, full_name, short_name, logo_url, campus_location, exam_pattern_summary
      FROM universities
      WHERE is_active = true
      ORDER BY code ASC
    `);
    console.log(`Fetched ${uniRes.rows.length} universities.`);

    // 2. Fetch academic subjects
    const subRes = await client.query(`
      SELECT id, name, slug, display_order
      FROM academic_subjects
      ORDER BY display_order ASC, name ASC
    `);
    console.log(`Fetched ${subRes.rows.length} academic subjects.`);

    // 3. Fetch academic units
    const unitRes = await client.query(`
      SELECT id, university_id, name, short_code, slug
      FROM academic_units
      ORDER BY short_code ASC
    `);
    console.log(`Fetched ${unitRes.rows.length} academic units.`);

    // 4. Fetch core exams: model_test, uni_exam, daily_live
    const examRes = await client.query(`
      SELECT e.id, e.title, e.track, e.exam_type, e.duration_seconds, 
             e.total_marks, e.negative_mark_per_question, e.starts_at, e.ends_at, e.is_active,
             u.code as university_code, u.full_name as university_name, u.logo_url as university_logo
      FROM exams e
      LEFT JOIN universities u ON e.target_university_id = u.id
      WHERE e.is_active = true AND e.exam_type IN ('model_test', 'uni_exam', 'daily_live')
      ORDER BY e.exam_type ASC, e.track ASC, e.title ASC
    `);
    console.log(`Fetched ${examRes.rows.length} core exams (model tests, uni exams, daily live).`);

    const examIds = examRes.rows.map(e => e.id);

    // 5. Fetch linked questions for these exams (excluding solution markdown)
    const eqRes = await client.query(`
      SELECT eq.exam_id, eq.question_order,
             q.id, q.stem_primary, q.options, q.difficulty_rating,
             q.item_type, q.subject_id, q.topic_id
      FROM exam_questions eq
      JOIN questions q ON eq.question_id = q.id
      WHERE eq.exam_id = ANY($1::uuid[])
      ORDER BY eq.exam_id, eq.question_order ASC
    `, [examIds]);
    console.log(`Fetched ${eqRes.rows.length} question links for core exams.`);

    const examQuestionsMap = {};
    for (const row of eqRes.rows) {
      if (!examQuestionsMap[row.exam_id]) {
        examQuestionsMap[row.exam_id] = [];
      }
      examQuestionsMap[row.exam_id].push({
        id: row.id,
        stem_primary: row.stem_primary,
        options: sanitizeOptions(row.options),
        difficulty_rating: row.difficulty_rating,
        item_type: row.item_type,
        subject_id: row.subject_id,
        topic_id: row.topic_id
      });
    }

    // 6. Fetch general practice questions (excluding solution markdown)
    const practiceRes = await client.query(`
      SELECT id, stem_primary, options, difficulty_rating,
             item_type, subject_id, topic_id
      FROM questions
      WHERE is_active = true
      ORDER BY random()
      LIMIT 150
    `);
    console.log(`Fetched ${practiceRes.rows.length} general practice questions for offline pool.`);

    const practiceQuestions = practiceRes.rows.map(row => ({
      id: row.id,
      stem_primary: row.stem_primary,
      options: sanitizeOptions(row.options),
      difficulty_rating: row.difficulty_rating,
      item_type: row.item_type,
      subject_id: row.subject_id,
      topic_id: row.topic_id
    }));

    const bundle = {
      version: 1,
      exported_at: new Date().toISOString(),
      universities: uniRes.rows,
      academic_subjects: subRes.rows,
      academic_units: unitRes.rows,
      exams: examRes.rows,
      exam_questions: examQuestionsMap,
      practice_questions: practiceQuestions
    };

    const outDir = path.resolve(__dirname, '../../../assets/cache');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const outPath = path.join(outDir, 'offline_bundle.json');
    fs.writeFileSync(outPath, JSON.stringify(bundle), 'utf8');

    const stats = fs.statSync(outPath);
    console.log(`Successfully exported offline bundle to ${outPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  exportOfflineCache().catch(err => {
    console.error('Export failed:', err);
    process.exit(1);
  });
}

module.exports = { exportOfflineCache, sanitizeOptions };
