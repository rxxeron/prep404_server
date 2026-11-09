const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function runAudit() {
  console.log('=== SUPABASE POSTGRES BEST PRACTICES AUDIT ===\n');

  // 1. Unindexed Foreign Keys
  const fkQuery = `
    SELECT
      c.conrelid::regclass::text AS table_name,
      a.attname AS fk_column,
      c.confrelid::regclass::text AS referenced_table
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f'
      AND c.connamespace = 'public'::regnamespace
      AND NOT EXISTS (
        SELECT 1 FROM pg_index i
        WHERE i.indrelid = c.conrelid AND a.attnum = ANY(i.indkey)
      );
  `;
  const fkRes = await pool.query(fkQuery);
  console.log('1. UNINDEXED FOREIGN KEYS (Risk: Full-table locks & slow cascades):');
  if (fkRes.rows.length === 0) {
    console.log('   ✓ All foreign keys are indexed!');
  } else {
    fkRes.rows.forEach(r => console.log(`   ⚠ Table: ${r.table_name} -> Column: ${r.fk_column} (References: ${r.referenced_table})`));
  }

  // 2. RLS Status
  const rlsQuery = `
    SELECT
      c.relname AS table_name,
      c.relrowsecurity AS rls_enabled,
      c.relforcerowsecurity AS rls_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname;
  `;
  const rlsRes = await pool.query(rlsQuery);
  console.log('\n2. ROW-LEVEL SECURITY (RLS) STATUS:');
  const unsecureTables = [];
  rlsRes.rows.forEach(r => {
    if (!r.rls_enabled) unsecureTables.push(r.table_name);
    console.log(`   ${r.rls_enabled ? '✓' : '✖'} ${r.table_name}: RLS=${r.rls_enabled}, Forced=${r.rls_forced}`);
  });

  // 3. Existing RLS Policies
  const polQuery = `
    SELECT
      schemaname,
      tablename,
      policyname,
      permissive,
      roles,
      cmd,
      qual,
      with_check
    FROM pg_policies
    WHERE schemaname = 'public';
  `;
  const polRes = await pool.query(polQuery);
  console.log(`\n3. ACTIVE RLS POLICIES (${polRes.rows.length} total):`);
  polRes.rows.forEach(p => {
    console.log(`   - [${p.tablename}] "${p.policyname}" FOR ${p.cmd} TO ${p.roles}: USING (${p.qual})`);
  });

  // 4. Index Inventory
  const idxQuery = `
    SELECT
      tablename,
      indexname,
      indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname;
  `;
  const idxRes = await pool.query(idxQuery);
  console.log(`\n4. EXISTING INDEXES (${idxRes.rows.length} total):`);
  idxRes.rows.forEach(i => {
    console.log(`   - ${i.tablename}.${i.indexname}`);
  });

  await pool.end();
}

runAudit().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
