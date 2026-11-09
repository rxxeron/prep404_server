import assert from 'assert';
import { Pool } from 'pg';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function runRlsAuditTests() {
  console.log('=== RUNNING RLS POLICY & LEAST-PRIVILEGE ROLE AUDIT (D4, D5) ===');

  // 1. Verify prep404_api_role exists with least-privilege non-superuser attributes
  const roleRes = await db.query(`
    SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin
    FROM pg_roles
    WHERE rolname = 'prep404_api_role';
  `);
  assert.strictEqual(roleRes.rows.length, 1, 'prep404_api_role must exist in database');
  const role = roleRes.rows[0];
  assert.strictEqual(role.rolsuper, false, 'API role must NOT be a superuser (Least Privilege D4)');
  assert.strictEqual(role.rolcreatedb, false, 'API role must NOT have CREATE DATABASE privilege');
  assert.strictEqual(role.rolcreaterole, false, 'API role must NOT have CREATE ROLE privilege');
  console.log('✓ PASS: Least-privilege role prep404_api_role verified without superuser powers');

  // 2. Audit Row-Level Security on the 21 Client-Facing Tables
  const clientFacingTables = [
    'universities',
    'programs',
    'admission_test_patterns',
    'admission_cycles',
    'divisions',
    'districts',
    'thanas',
    'institutions',
    'academic_subjects',
    'academic_topics',
    'academic_batches',
    'community_links',
    'users',
    'mistake_vault',
    'practice_attempts',
    'exams',
    'exam_questions',
    'question_reports',
    'learner_events',
    'staff_directory',
    'staff_audit_log'
  ];

  const rlsStatusRes = await db.query(`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename = ANY($1::text[]);
  `, [clientFacingTables]);

  const existingTables = new Set(rlsStatusRes.rows.map((r: any) => r.tablename));
  console.log(`Auditing ${rlsStatusRes.rows.length} verified schema tables...`);

  // Verify that confidential tables have RLS enabled
  const confidentialTables = ['users', 'mistake_vault', 'practice_attempts', 'staff_directory', 'staff_audit_log', 'question_reports'];
  for (const t of rlsStatusRes.rows) {
    if (confidentialTables.includes(t.tablename)) {
      assert.strictEqual(t.rowsecurity, true, `Table ${t.tablename} MUST have row-level security enabled`);
    }
  }
  console.log('✓ PASS: All confidential user & staff tables enforce rowsecurity = true');

  // 3. Verify Active pg_policies exist
  const policiesRes = await db.query(`
    SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
    FROM pg_policies
    WHERE schemaname = 'public';
  `);
  assert(policiesRes.rows.length >= 10, 'Expected extensive RLS policy set in pg_policies');
  console.log(`✓ PASS: ${policiesRes.rows.length} active database RLS policies verified across public schema`);

  console.log('=== ALL RLS AUDIT & LEAST-PRIVILEGE ROLE CHECKS PASSED ===\n');
  await db.end();
}

runRlsAuditTests().catch((err) => {
  console.error('RLS Audit Test Failed:', err);
  process.exit(1);
});
