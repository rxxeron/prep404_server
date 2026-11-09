const { Pool } = require('pg');
require('dotenv').config({ path: './server/.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function formatTitle(rawSlug, isModel, uniCode, term, year, slot) {
  let slug = rawSlug.trim();
  
  if (isModel) {
    if (/^model_test_(\d+)$/i.test(slug)) {
      const num = slug.match(/^model_test_(\d+)$/i)[1].padStart(2, '0');
      return `${uniCode} Admission Model Test ${num}`;
    }
    if (/^\d+$/.test(slug)) {
      return `${uniCode} Admission Model Test ${slug.padStart(2, '0')}`;
    }
    if (slug.includes('SAMPLE_QUESTION') || slug.includes('sample_question')) {
      const clean = slug.replace(/_SAMPLE_QUESTION.*/i, '').replace(/_sample_question.*/i, '').replace(new RegExp(`^${uniCode}_`, 'i'), '').replace(/_/g, ' ');
      return `${uniCode} ${clean.toUpperCase()} Official Model Test`;
    }
    if (slug.startsWith('uap_')) {
      const clean = slug.replace('uap_', '').replace(/_/g, ' ').toUpperCase();
      return `UAP ${clean} Admission Model Test`;
    }
    return `${uniCode} Admission Model Test (${slug.replace(/_/g, ' ')})`;
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
    return `${uniCode} Real Admission Test - ${term || ''} ${year || ''} ${slug.replace(/_/g, ' ')}`.trim();
  }
}

function formatSectionTitle(examTitle, secCode, secTitle, uniCode) {
  let title = secTitle || secCode;
  title = title.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  // Capitalize nicely
  title = title.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return `${examTitle} - ${title}`;
}

async function dryRun() {
  // 1. Group by Full Exams
  const fullExams = await pool.query(`
    SELECT 
      qea.university_id,
      u.code as uni_code,
      u.full_name as uni_name,
      qea.exam_slug,
      qea.is_model_test,
      qea.academic_term,
      qea.academic_year,
      qea.slot_number,
      count(DISTINCT qea.question_id) as q_count
    FROM question_exam_appearances qea
    JOIN universities u ON u.id = qea.university_id
    GROUP BY qea.university_id, u.code, u.full_name, qea.exam_slug, qea.is_model_test, qea.academic_term, qea.academic_year, qea.slot_number
    ORDER BY u.code, qea.is_model_test, qea.exam_slug;
  `);

  console.log(`Discovered ${fullExams.rows.length} Full Exams (Model Tests & Real University Exams):`);
  let modelCount = 0;
  let uniCount = 0;
  for (const row of fullExams.rows) {
    if (row.is_model_test) modelCount++;
    else uniCount++;
    const formatted = formatTitle(row.exam_slug, row.is_model_test, row.uni_code, row.academic_term, row.academic_year, row.slot_number);
    console.log(`  [${row.is_model_test ? 'MODEL' : 'REAL_UNI'}] [${row.uni_code}] (${row.q_count} Qs): ${formatted}`);
  }
  console.log(`\nSummary: ${modelCount} Model Tests, ${uniCount} Real University Exams.`);

  // 2. Group by Section Exams
  const sectionExams = await pool.query(`
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
  console.log(`\nDiscovered ${sectionExams.rows.length} Section-Specific Exams.`);
  console.log(`Sample Section Exams (first 10):`);
  for (const s of sectionExams.rows.slice(0, 10)) {
    const parentTitle = formatTitle(s.exam_slug, s.is_model_test, s.uni_code, s.academic_term, s.academic_year, s.slot_number);
    const secTitle = formatSectionTitle(parentTitle, s.section_code, s.section_title, s.uni_code);
    console.log(`  [SECTION] [${s.uni_code}] (${s.q_count} Qs): ${secTitle}`);
  }

  await pool.end();
}

dryRun().catch(console.error);
