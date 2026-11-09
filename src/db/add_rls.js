const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    console.log('Applying RLS read policies for divisions, districts, thanas, institutions...');
    await pool.query(`
      ALTER TABLE divisions ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "Divisions are viewable by everyone" ON divisions;
      CREATE POLICY "Divisions are viewable by everyone" ON divisions FOR SELECT USING (true);

      ALTER TABLE districts ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "Districts are viewable by everyone" ON districts;
      CREATE POLICY "Districts are viewable by everyone" ON districts FOR SELECT USING (true);

      ALTER TABLE thanas ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "Thanas are viewable by everyone" ON thanas;
      CREATE POLICY "Thanas are viewable by everyone" ON thanas FOR SELECT USING (true);

      ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "Institutions are viewable by everyone" ON institutions;
      CREATE POLICY "Institutions are viewable by everyone" ON institutions FOR SELECT USING (true);
    `);
    console.log('✓ All 4 public read policies successfully applied to Supabase!');
  } catch (err) {
    console.error('Error applying policies:', err);
  } finally {
    await pool.end();
  }
}

run();
