const { Pool } = require('pg');
require('dotenv').config({ path: '.env' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function check() {
  const r = await pool.query(`
    SELECT slug, title, question_count, exam_type 
    FROM exam_snapshots 
    ORDER BY slug
  `);
  console.log(`Total snapshots: ${r.rows.length}`);
  const byUni = {};
  for (const row of r.rows) {
    let u = 'OTHER';
    for (const code of ['bracu', 'nsu', 'iub', 'aust', 'aiub', 'ewu', 'uiu', 'uap']) {
      if (row.slug.toLowerCase().includes(code)) {
        u = code.toUpperCase();
        break;
      }
    }
    if (!byUni[u]) byUni[u] = [];
    byUni[u].push(row);
  }
  for (const [k, v] of Object.entries(byUni)) {
    console.log(`\n=== ${k} (${v.length} snapshots) ===`);
    v.slice(0, 8).forEach(x => console.log(`  ${x.slug} | ${x.title}`));
  }
  await pool.end();
}

check().catch(console.error);
