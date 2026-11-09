const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const connStr = process.env.DATABASE_URL;
if (!connStr) throw new Error('DATABASE_URL is required; refusing to run migration without an explicit target.');

async function migrate() {
  const client = new Client({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('[Supabase Migration] Connected successfully.');

    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    console.log('[Supabase Migration] Applying schema.sql...');
    await client.query(schemaSql);
    console.log('[Supabase Migration] Schema applied successfully!');

    const seedsPath = path.join(__dirname, 'seeds.sql');
    const seedsSql = fs.readFileSync(seedsPath, 'utf8');
    console.log('[Supabase Migration] Applying seeds.sql...');
    await client.query(seedsSql);
    console.log('[Supabase Migration] Seeds applied successfully!');

    const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    console.log('[Supabase Migration] Verification: Available Tables:');
    console.log(res.rows.map(r => r.table_name));

    const uniCount = await client.query('SELECT count(*) FROM public.universities;');
    const questionCount = await client.query('SELECT count(*) FROM questions;');
    console.log(`[Supabase Migration] Verified ${uniCount.rows[0].count} private universities & ${questionCount.rows[0].count} questions seeded.`);

  } catch (err) {
    console.error('[Supabase Migration] Error:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
