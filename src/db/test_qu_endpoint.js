require('dotenv').config({ path: 'server/.env' });
const { Pool } = require('pg');

async function testQueryDirectly() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    console.log('--- Testing Postgres Snapshot Query ---');
    const slug = 'nsu-admission-special-cliffs-toefl-grammar-mini-test-01';
    const res = await client.query('SELECT payload_json FROM exam_snapshots WHERE slug = $1 LIMIT 1', [slug]);
    if (res.rows.length === 0) {
      console.log('Snapshot not found for slug:', slug);
      const any = await client.query('SELECT slug, title, question_count FROM exam_snapshots LIMIT 3');
      console.log('Sample available slugs:', any.rows);
      return;
    }

    const payload = res.rows[0].payload_json;
    console.log('Found snapshot!');
    console.log('Title:          ', payload.title);
    console.log('Slug:           ', payload.slug);
    console.log('Access Key:     ', payload.accessKey);
    console.log('Question Count: ', payload.questionCount);
    console.log('First Question: ', payload.questions[0]?.questionText);
    console.log('Options Count:  ', payload.questions[0]?.options.length);
  } finally {
    client.release();
    await pool.end();
  }
}

testQueryDirectly().catch(console.error);
