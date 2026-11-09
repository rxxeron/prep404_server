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

function cleanTitle(rawSlug, isModel, uniCode, term, year, slot) {
  let slug = (rawSlug || '').trim();
  
  if (isModel) {
    if (/^model_test_(\d+)$/i.test(slug)) {
      const num = slug.match(/^model_test_(\d+)$/i)[1].padStart(2, '0');
      return `${uniCode} Admission Model Test ${num}`;
    }
    if (/^\d+$/.test(slug)) {
      return `${uniCode} Admission Model Test ${slug.padStart(2, '0')}`;
    }
    if (slug.toUpperCase().includes('SAMPLE_QUESTION')) {
      let clean = slug.replace(/_SAMPLE_QUESTION.*/i, '')
                      .replace(new RegExp(`^${uniCode}_`, 'i'), '')
                      .replace(/_/g, ' ')
                      .trim();
      return `${uniCode} ${clean.toUpperCase()} Official Model Test`;
    }
    if (slug.startsWith('uap_')) {
      const clean = slug.replace('uap_', '').replace(/_/g, ' ').toUpperCase();
      return `UAP ${clean} Admission Model Test`;
    }
    return `${uniCode} Admission Model Test (${slug.replace(/_/g, ' ').toUpperCase()})`;
  } else {
    // Real University Exam
    if (slug.startsWith('BRACU_REAL_')) {
      const part = slug.replace('BRACU_REAL_', '').replace(/_/g, ' ');
      return `BRACU Admission Test (${part})`;
    }
    if (slug.startsWith('nsu_')) {
      const part = slug.replace('nsu_', '').replace(/_/g, ' ').toUpperCase();
      return `NSU Admission Test (${part})`;
    }
    if (slug.startsWith('past_exam_')) {
      const part = slug.replace('past_exam_', '').replace(/_/g, ' ').toUpperCase();
      return `${uniCode} Past Admission Test (${part})`;
    }
    if (slug === 'fall_2022' || slug === 'spring_2023') {
      return `${uniCode} Admission Test (${slug.replace(/_/g, ' ').toUpperCase()})`;
    }
    if (slug.includes('east_west_university_admission_test')) {
      const part = slug.includes('fbs') ? 'Summer 2025 (FBS)' : 'Summer 2025 (FSE)';
      return `EWU Admission Test - ${part}`;
    }
    if (slug.includes('iub_summer_2025')) {
      return `IUB Admission Test (Summer 2025 Slot 2)`;
    }
    if (slug.includes('architecture_and_admission_guidelines')) {
      return `BRACU Architecture & OMR Guidelines Test`;
    }
    const cleanSlug = slug.replace(/_/g, ' ').toUpperCase();
    return `${uniCode} Real Admission Test - ${term || ''} ${year || ''} ${cleanSlug}`.replace(/\s+/g, ' ').trim();
  }
}

function cleanSectionName(secCode, secTitle) {
  let title = secTitle || secCode;
  title = title.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return title.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

async function populateFast() {
  console.log('=== Starting Ultra-Fast Batch Exam Population ===');
  const startTime = Date.now();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Fetch distinct Full Exams
    const fullExamsRes = await client.query(`
      SELECT 
        qea.university_id,
        u.code as uni_code,
        qea.exam_slug,
        qea.is_model_test,
        qea.academic_term,
        qea.academic_year,
        qea.slot_number,
        count(DISTINCT qea.question_id) as total_questions
      FROM question_exam_appearances qea
      JOIN universities u ON u.id = qea.university_id
      GROUP BY qea.university_id, u.code, qea.exam_slug, qea.is_model_test, qea.academic_term, qea.academic_year, qea.slot_number
      ORDER BY u.code, qea.is_model_test, qea.exam_slug;
    `);

    console.log(`Discovered ${fullExamsRes.rows.length} Full Exams.`);

    const examRows = [];
    const fullExamKeyToUuid = new Map();

    for (const row of fullExamsRes.rows) {
      const isModel = row.is_model_test === true;
      const examType = isModel ? 'model_test' : 'uni_exam';
      const examTitle = cleanTitle(row.exam_slug, isModel, row.uni_code, row.academic_term, row.academic_year, row.slot_number);
      const examUuid = toDeterministicUuid(`full_exam:${row.uni_code}:${row.exam_slug}:${examType}`);
      fullExamKeyToUuid.set(`${row.university_id}_${row.exam_slug}`, examUuid);

      const qCount = parseInt(row.total_questions, 10);
      const durationMins = Math.max(20, Math.round((qCount * 1.2) / 5) * 5);
      const durationSeconds = durationMins * 60;
      const totalMarks = qCount >= 80 ? 100.0 : (qCount >= 40 ? 50.0 : parseFloat(qCount.toFixed(1)));
      const negativeMark = row.uni_code === 'NSU' ? 0.0 : 0.25;

      examRows.push({
        id: examUuid,
        title: examTitle,
        track: row.uni_code,
        exam_type: examType,
        duration_seconds: durationSeconds,
        total_marks: totalMarks,
        negative_mark_per_question: negativeMark,
        target_university_id: row.university_id
      });
    }

    // 2. Fetch distinct Section-Specific Exams
    const sectionExamsRes = await client.query(`
      SELECT 
        qea.university_id,
        u.code as uni_code,
        qea.exam_slug,
        qea.is_model_test,
        qea.academic_term,
        qea.academic_year,
        qea.slot_number,
        qea.section_code,
        min(qea.section_title) as section_title,
        count(DISTINCT qea.question_id) as q_count
      FROM question_exam_appearances qea
      JOIN universities u ON u.id = qea.university_id
      GROUP BY qea.university_id, u.code, qea.exam_slug, qea.is_model_test, qea.academic_term, qea.academic_year, qea.slot_number, qea.section_code
      ORDER BY u.code, qea.exam_slug, qea.section_code;
    `);

    console.log(`Discovered ${sectionExamsRes.rows.length} Section-Specific Exams.`);
    const sectionExamKeyToUuid = new Map();

    for (const s of sectionExamsRes.rows) {
      const parentTitle = cleanTitle(s.exam_slug, s.is_model_test, s.uni_code, s.academic_term, s.academic_year, s.slot_number);
      const secName = cleanSectionName(s.section_code, s.section_title);
      const fullSectionTitle = `${parentTitle} - ${secName}`;
      const sectionUuid = toDeterministicUuid(`section_exam:${s.uni_code}:${s.exam_slug}:${s.section_code}`);
      sectionExamKeyToUuid.set(`${s.university_id}_${s.exam_slug}_${s.section_code}`, sectionUuid);

      const qCount = parseInt(s.q_count, 10);
      const durationMins = Math.max(15, Math.round((qCount * 1.2) / 5) * 5);
      const durationSeconds = durationMins * 60;
      const totalMarks = parseFloat(qCount.toFixed(1));
      const negativeMark = s.uni_code === 'NSU' ? 0.0 : 0.25;

      examRows.push({
        id: sectionUuid,
        title: fullSectionTitle,
        track: s.uni_code,
        exam_type: 'section_exam',
        duration_seconds: durationSeconds,
        total_marks: totalMarks,
        negative_mark_per_question: negativeMark,
        target_university_id: s.university_id
      });
    }

    console.log(`Total exams to upsert: ${examRows.length}`);

    // Batch upsert all exams using UNNEST
    await client.query(`
      INSERT INTO exams (
        id, title, track, exam_type, duration_seconds, total_marks,
        negative_mark_per_question, starts_at, ends_at, is_active,
        target_university_id, created_at
      )
      SELECT 
        u.id, u.title, u.track, u.exam_type, u.duration_seconds, u.total_marks,
        u.negative_mark_per_question, NOW() - INTERVAL '1 day',
        NOW() + INTERVAL '365 days', true, u.target_university_id, NOW()
      FROM UNNEST(
        $1::uuid[],
        $2::varchar[],
        $3::varchar[],
        $4::varchar[],
        $5::int[],
        $6::float8[],
        $7::float8[],
        $8::uuid[]
      ) AS u(id, title, track, exam_type, duration_seconds, total_marks, negative_mark_per_question, target_university_id)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        track = EXCLUDED.track,
        exam_type = EXCLUDED.exam_type,
        duration_seconds = EXCLUDED.duration_seconds,
        total_marks = EXCLUDED.total_marks,
        negative_mark_per_question = EXCLUDED.negative_mark_per_question,
        is_active = true,
        target_university_id = EXCLUDED.target_university_id;
    `, [
      examRows.map(r => r.id),
      examRows.map(r => r.title),
      examRows.map(r => r.track),
      examRows.map(r => r.exam_type),
      examRows.map(r => r.duration_seconds),
      examRows.map(r => r.total_marks),
      examRows.map(r => r.negative_mark_per_question),
      examRows.map(r => r.target_university_id)
    ]);

    console.log(`All ${examRows.length} exams upserted successfully in one query.`);

    // 3. Clear and re-populate exam_questions for all generated exams
    const allExamUuids = examRows.map(r => r.id);
    await client.query(`DELETE FROM exam_questions WHERE exam_id = ANY($1::uuid[])`, [allExamUuids]);

    // Insert Full Exam Questions in one single query directly from question_exam_appearances!
    console.log('Mapping Full Exam questions directly via SQL set operation...');
    const fullEqRes = await client.query(`
      WITH ranked_full AS (
        SELECT 
          qea.university_id,
          qea.exam_slug,
          qea.question_id,
          COALESCE(qea.question_number, 9999) as q_num,
          ROW_NUMBER() OVER (
            PARTITION BY qea.university_id, qea.exam_slug 
            ORDER BY COALESCE(qea.question_number, 9999) ASC, qea.id ASC
          ) as ord
        FROM (
          SELECT DISTINCT ON (university_id, exam_slug, question_id) 
            university_id, exam_slug, question_id, question_number, id
          FROM question_exam_appearances
        ) qea
      )
      SELECT 
        rf.university_id,
        rf.exam_slug,
        rf.question_id,
        rf.ord
      FROM ranked_full rf;
    `);

    const fullEqExams = [];
    const fullEqQuestions = [];
    const fullEqOrders = [];

    for (const row of fullEqRes.rows) {
      const examUuid = fullExamKeyToUuid.get(`${row.university_id}_${row.exam_slug}`);
      if (examUuid) {
        fullEqExams.push(examUuid);
        fullEqQuestions.push(row.question_id);
        fullEqOrders.push(row.ord);
      }
    }

    if (fullEqExams.length > 0) {
      console.log(`Inserting ${fullEqExams.length} Full Exam question links...`);
      await client.query(`
        INSERT INTO exam_questions (exam_id, question_id, question_order)
        SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::int[])
        ON CONFLICT (exam_id, question_id) DO NOTHING;
      `, [fullEqExams, fullEqQuestions, fullEqOrders]);
    }

    // Insert Section Exam Questions in one single query!
    console.log('Mapping Section Exam questions directly via SQL set operation...');
    const secEqRes = await client.query(`
      WITH ranked_sec AS (
        SELECT 
          qea.university_id,
          qea.exam_slug,
          qea.section_code,
          qea.question_id,
          COALESCE(qea.question_number, 9999) as q_num,
          ROW_NUMBER() OVER (
            PARTITION BY qea.university_id, qea.exam_slug, qea.section_code 
            ORDER BY COALESCE(qea.question_number, 9999) ASC, qea.id ASC
          ) as ord
        FROM (
          SELECT DISTINCT ON (university_id, exam_slug, section_code, question_id) 
            university_id, exam_slug, section_code, question_id, question_number, id
          FROM question_exam_appearances
        ) qea
      )
      SELECT 
        rs.university_id,
        rs.exam_slug,
        rs.section_code,
        rs.question_id,
        rs.ord
      FROM ranked_sec rs;
    `);

    const secEqExams = [];
    const secEqQuestions = [];
    const secEqOrders = [];

    for (const row of secEqRes.rows) {
      const examUuid = sectionExamKeyToUuid.get(`${row.university_id}_${row.exam_slug}_${row.section_code}`);
      if (examUuid) {
        secEqExams.push(examUuid);
        secEqQuestions.push(row.question_id);
        secEqOrders.push(row.ord);
      }
    }

    if (secEqExams.length > 0) {
      console.log(`Inserting ${secEqExams.length} Section Exam question links...`);
      await client.query(`
        INSERT INTO exam_questions (exam_id, question_id, question_order)
        SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::int[])
        ON CONFLICT (exam_id, question_id) DO NOTHING;
      `, [secEqExams, secEqQuestions, secEqOrders]);
    }

    await client.query('COMMIT');
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`=== Done in ${elapsed}s! ===`);

    // Verify totals
    const totalExams = await client.query('SELECT exam_type, count(*) FROM exams GROUP BY exam_type ORDER BY count DESC');
    console.log('\nExams table breakdown:');
    console.table(totalExams.rows);

    const totalEq = await client.query('SELECT count(*) FROM exam_questions');
    console.log(`Total exam_questions links: ${totalEq.rows[0].count}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Fast population failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

populateFast().catch(console.error);
