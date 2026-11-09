const { Pool } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf-8');
const dbMatch = env.match(/DATABASE_URL=([^\r\n]+)/);
const pool = new Pool({ connectionString: dbMatch[1].trim(), ssl: { rejectUnauthorized: false } });

async function run() {
  for (const t of ['admission_test_patterns', 'admission_pattern_sections', 'program_pattern_mappings', 'university_blueprints']) {
    const cols = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1", [t]);
    console.log(`\n=== ${t} ===`);
    console.log(cols.rows.map(c => `${c.column_name} (${c.data_type})`).join(', '));
    const sample = await pool.query(`SELECT * FROM ${t} LIMIT 5`);
    console.log('Sample rows:', sample.rows);
  }

  await pool.end();
}

run().catch(console.error);
