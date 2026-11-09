const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const client = await pool.connect();
  try {
    console.log('[Universities Exam Format] Connecting...');
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE public.universities 
      ADD COLUMN IF NOT EXISTS exam_format_type VARCHAR(50) DEFAULT 'faculty_wide',
      ADD COLUMN IF NOT EXISTS exam_pattern_summary TEXT;
    `);

    const uniExamData = [
      {
        code: 'NSU',
        format: 'centralized',
        summary: 'Centralized university test covering English, Mathematics, Analytical & Essay with department cutoffs (Architecture has mandatory drawing test).'
      },
      {
        code: 'BRACU',
        format: 'centralized',
        summary: 'Centralized assessment for English, Mathematics, and Written Expression; stream evaluation and remedial course placement.'
      },
      {
        code: 'IUB',
        format: 'centralized',
        summary: 'Centralized examination testing English and Quantitative Mathematics, with Higher Math emphasis for SETS engineering applicants.'
      },
      {
        code: 'AUST',
        format: 'faculty_wide',
        summary: 'Faculty-wide exams: Category 1 (All Engineering units - CSE/EEE/CE/ME/IPE/TE) takes unified 320-mark Math/Physics/Chem/English MCQ; Category 2 adds Drawing; Category 3 for BBA.'
      },
      {
        code: 'EWU',
        format: 'faculty_wide',
        summary: 'Faculty-wide exams separated by stream: Faculty of Business (100 marks), Sciences & Engineering (Higher Math, Physics, Chemistry), and Life Sciences (Pharmacy/Biology).'
      },
      {
        code: 'AIUB',
        format: 'faculty_wide',
        summary: 'Faculty-wide exams for FST/Engineering (100 mins MCQ + Essay, Calculators prohibited) and FBA (BBA Quantitative & English paragraph).'
      },
      {
        code: 'UIU',
        format: 'faculty_wide',
        summary: 'School-wide examinations: School of Science & Engineering (75 marks Math/Physics/English), School of Business (75 marks), and School of Life Sciences.'
      },
      {
        code: 'UAP',
        format: 'department_wise',
        summary: 'Department-wise independent exams: Each department (CSE, EEE, Pharmacy, BBA, Architecture, Law) sets its own custom marks breakdown and question pattern.'
      }
    ];

    for (const item of uniExamData) {
      await client.query(`
        UPDATE public.universities 
        SET exam_format_type = $1, exam_pattern_summary = $2
        WHERE code = $3;
      `, [item.format, item.summary, item.code]);
    }

    await client.query('COMMIT');
    console.log('[Universities Exam Format] Successfully updated all 8 universities with exam format metadata.');

    const res = await client.query(`SELECT code, exam_format_type, exam_pattern_summary FROM public.universities ORDER BY code;`);
    res.rows.forEach(r => console.log(`  ${r.code} [${r.exam_format_type}]: ${r.exam_pattern_summary}`));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
