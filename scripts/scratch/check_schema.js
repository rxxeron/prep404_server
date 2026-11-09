const { Pool } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf-8');
const dbMatch = env.match(/DATABASE_URL=([^\r\n]+)/);
const pool = new Pool({ connectionString: dbMatch[1].trim(), ssl: { rejectUnauthorized: false } });

async function run() {
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  console.log('Tables:', tables.rows.map(r => r.tablename));

  for (const t of ['universities', 'academic_units', 'programs', 'admission_cycles', 'exams', 'exam_snapshots']) {
    if (tables.rows.some(r => r.tablename === t)) {
      const cols = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1", [t]);
      console.log(`\n--- ${t} columns ---`);
      console.log(cols.rows.map(c => `${c.column_name} (${c.data_type})`).join(', '));
      const count = await pool.query(`SELECT count(*) FROM ${t}`);
      console.log(`Total rows in ${t}:`, count.rows[0].count);
    }
  }

  await pool.end();
}

run().catch(console.error);
