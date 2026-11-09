const { Pool } = require('pg');
require('dotenv').config({ path: './.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const r = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default 
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'exams'
    ORDER BY ordinal_position
  `);
  console.log('Exams columns:', r.rows);

  const r2 = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default 
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'exam_questions'
    ORDER BY ordinal_position
  `);
  console.log('Exam questions columns:', r2.rows);

  const r3 = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default 
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'exam_submissions'
    ORDER BY ordinal_position
  `);
  console.log('Exam submissions columns:', r3.rows);

  await pool.end();
}

run().catch(console.error);
