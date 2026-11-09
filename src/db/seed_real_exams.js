const { Pool } = require('pg');
require('dotenv').config({ path: './.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log('--- SEEDING REAL MODEL TESTS IN SUPABASE POSTGRESQL ---');

  const countRes = await pool.query('SELECT count(*) FROM exams');
  if (parseInt(countRes.rows[0].count, 10) > 0) {
    console.log(`Exams table already has ${countRes.rows[0].count} exams. Checking linked questions...`);
  }

  // Fetch universities
  const unis = await pool.query('SELECT id, code, full_name, slug FROM universities');
  const uniMap = {};
  unis.rows.forEach(u => {
    uniMap[u.code] = u.id;
  });

  // Fetch academic subjects
  const subjects = await pool.query('SELECT id, slug, name FROM academic_subjects');
  const subMap = {};
  subjects.rows.forEach(s => {
    subMap[s.slug] = s.id;
  });

  // Model test definitions
  const testDefs = [
    {
      title: 'Daily Live National Model Test #24 (Private Varsity)',
      track: 'General',
      exam_type: 'daily_live',
      duration_seconds: 1800, // 30 mins
      total_marks: 25.0,
      negative_mark_per_question: 0.25,
      starts_at: new Date(Date.now() - 3600000).toISOString(),
      ends_at: new Date(Date.now() + 86400000 * 3).toISOString(),
      target_university_id: uniMap['NSU'] || null,
      question_count: 25,
      subject_slugs: ['general_mathematics', 'higher_mathematics', 'english', 'physics']
    },
    {
      title: 'NSU SEPS Engineering & Computing Admission Test',
      track: 'NSU',
      exam_type: 'model_test',
      duration_seconds: 5400, // 90 mins
      total_marks: 50.0,
      negative_mark_per_question: 0.0,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 86400000 * 30).toISOString(),
      target_university_id: uniMap['NSU'],
      question_count: 50,
      subject_slugs: ['higher_mathematics', 'general_mathematics', 'english']
    },
    {
      title: 'BRACU CSE & Architecture Grand Model Test',
      track: 'BRACU',
      exam_type: 'model_test',
      duration_seconds: 5400, // 90 mins
      total_marks: 50.0,
      negative_mark_per_question: 0.0,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 86400000 * 30).toISOString(),
      target_university_id: uniMap['BRACU'],
      question_count: 50,
      subject_slugs: ['higher_mathematics', 'general_mathematics', 'english']
    },
    {
      title: 'AUST Engineering Rigorous HSC Model Test',
      track: 'AUST',
      exam_type: 'model_test',
      duration_seconds: 7200, // 120 mins
      total_marks: 60.0,
      negative_mark_per_question: 0.25,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 86400000 * 30).toISOString(),
      target_university_id: uniMap['AUST'],
      question_count: 60,
      subject_slugs: ['higher_mathematics', 'physics', 'chemistry', 'english']
    },
    {
      title: 'NSU SBE Business & Economics Admission Test',
      track: 'NSU',
      exam_type: 'model_test',
      duration_seconds: 3600, // 60 mins
      total_marks: 50.0,
      negative_mark_per_question: 0.0,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 86400000 * 30).toISOString(),
      target_university_id: uniMap['NSU'],
      question_count: 50,
      subject_slugs: ['general_mathematics', 'english']
    },
    {
      title: 'IUB School of Engineering & Technology Model Test',
      track: 'IUB',
      exam_type: 'model_test',
      duration_seconds: 3600, // 60 mins
      total_marks: 40.0,
      negative_mark_per_question: 0.0,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 86400000 * 30).toISOString(),
      target_university_id: uniMap['IUB'],
      question_count: 40,
      subject_slugs: ['general_mathematics', 'english', 'physics']
    }
  ];

  for (const def of testDefs) {
    // Check if exists by title
    const check = await pool.query('SELECT id FROM exams WHERE title = $1', [def.title]);
    let examId;
    if (check.rows.length === 0) {
      const ins = await pool.query(`
        INSERT INTO exams (
          title, track, exam_type, duration_seconds, total_marks,
          negative_mark_per_question, starts_at, ends_at, is_active, target_university_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)
        RETURNING id
      `, [
        def.title, def.track, def.exam_type, def.duration_seconds, def.total_marks,
        def.negative_mark_per_question, def.starts_at, def.ends_at, def.target_university_id
      ]);
      examId = ins.rows[0].id;
      console.log(`✓ Created exam: "${def.title}" (ID: ${examId})`);
    } else {
      examId = check.rows[0].id;
      console.log(`Exam already exists: "${def.title}" (ID: ${examId})`);
    }

    // Link real questions from questions table if not already linked
    const qCount = await pool.query('SELECT count(*) FROM exam_questions WHERE exam_id = $1', [examId]);
    if (parseInt(qCount.rows[0].count, 10) === 0) {
      // Fetch real questions for the subjects
      const subIds = def.subject_slugs.map(s => subMap[s]).filter(Boolean);
      let qResult;
      if (subIds.length > 0) {
        qResult = await pool.query(`
          SELECT id FROM questions 
          WHERE subject_id = ANY($1::uuid[]) AND is_active = true 
          ORDER BY random() 
          LIMIT $2
        `, [subIds, def.question_count]);
      }
      if (!qResult || qResult.rows.length < def.question_count) {
        // Fallback to any active questions
        qResult = await pool.query(`
          SELECT id FROM questions 
          WHERE is_active = true 
          ORDER BY random() 
          LIMIT $1
        `, [def.question_count]);
      }

      console.log(`  Linking ${qResult.rows.length} real questions to exam...`);
      for (let i = 0; i < qResult.rows.length; i++) {
        await pool.query(`
          INSERT INTO exam_questions (exam_id, question_id, question_order)
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING
        `, [examId, qResult.rows[i].id, i + 1]);
      }
      console.log(`  ✓ Linked ${qResult.rows.length} questions to exam "${def.title}"`);
    }
  }

  const finalExams = await pool.query('SELECT count(*) FROM exams');
  const finalLinks = await pool.query('SELECT count(*) FROM exam_questions');
  console.log(`\nDONE: ${finalExams.rows[0].count} exams, ${finalLinks.rows[0].count} exam_question links.`);
  await pool.end();
}

run().catch(console.error);
