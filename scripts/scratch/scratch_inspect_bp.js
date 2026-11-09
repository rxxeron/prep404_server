const { Pool } = require('pg');
require('dotenv').config({ path: '.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const rls = await pool.query(`
      SELECT schemaname, tablename, rowsecurity 
      FROM pg_tables 
      WHERE tablename IN ('universities', 'admission_test_patterns', 'university_blueprints', 'admission_cycles', 'programs')
    `);
    console.log("RLS status:", rls.rows);

    const policies = await pool.query(`
      SELECT policyname, tablename, roles, cmd, qual 
      FROM pg_policies 
      WHERE tablename = 'university_blueprints'
    `);
    console.log("university_blueprints policies:", policies.rows);

    // If RLS is enabled without a public select policy, let's add one so Flutter can read it!
    await pool.query(`
      ALTER TABLE university_blueprints ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "Allow public read on university_blueprints" ON university_blueprints;
      CREATE POLICY "Allow public read on university_blueprints" ON university_blueprints FOR SELECT USING (true);
    `);
    console.log("Enabled public read policy on university_blueprints!");
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
