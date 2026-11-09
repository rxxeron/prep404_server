const { Pool } = require('pg');
require('dotenv').config({ path: './.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log('[Migration] Connecting to Supabase Postgres...');
  const client = await pool.connect();
  try {
    console.log('[Migration] Adding education & demographic columns to users table...');
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS gender VARCHAR(20),
        ADD COLUMN IF NOT EXISTS division_id VARCHAR(50),
        ADD COLUMN IF NOT EXISTS division_name VARCHAR(100),
        ADD COLUMN IF NOT EXISTS district_id VARCHAR(50),
        ADD COLUMN IF NOT EXISTS district_name VARCHAR(100),
        ADD COLUMN IF NOT EXISTS nctb_version VARCHAR(20),
        ADD COLUMN IF NOT EXISTS ssc_group VARCHAR(50),
        ADD COLUMN IF NOT EXISTS ssc_year VARCHAR(10),
        ADD COLUMN IF NOT EXISTS ssc_gpa VARCHAR(10),
        ADD COLUMN IF NOT EXISTS ssc_institution VARCHAR(255),
        ADD COLUMN IF NOT EXISTS ssc_eiin VARCHAR(20),
        ADD COLUMN IF NOT EXISTS hsc_group VARCHAR(50),
        ADD COLUMN IF NOT EXISTS hsc_batch VARCHAR(30),
        ADD COLUMN IF NOT EXISTS hsc_gpa VARCHAR(30),
        ADD COLUMN IF NOT EXISTS hsc_institution VARCHAR(255),
        ADD COLUMN IF NOT EXISTS hsc_eiin VARCHAR(20);
    `);
    console.log('[Migration] Columns successfully added or already exist!');

    // Verify
    const res = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = 'users' 
      ORDER BY ordinal_position;
    `);
    console.log('[Migration] Current columns on users:');
    res.rows.forEach(r => console.log(`  - ${r.column_name}: ${r.data_type}`));
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('[Migration] Failed:', err);
  process.exit(1);
});
