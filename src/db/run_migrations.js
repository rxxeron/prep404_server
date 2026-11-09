/**
 * Prep404 migration runner.
 *
 * Applies every file in ./migrations in filename order, each in its own
 * transaction, and records it in public.schema_migrations so it never runs
 * twice. Filenames are sortable (YYYYMMDD_description.sql); a migration that
 * depends on another must sort after it.
 *
 *   node src/db/run_migrations.js            apply pending migrations
 *   node src/db/run_migrations.js --status   list applied and pending files
 *   node src/db/run_migrations.js --baseline record every current file as
 *                                            applied WITHOUT running it (use
 *                                            once on a database that was
 *                                            migrated by hand)
 *
 * Requires DATABASE_URL. A second runner waits on an advisory lock instead of
 * racing the first.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

try {
  require('dotenv').config({ path: path.join(__dirname, '../../.env') });
  require('dotenv').config();
} catch {}

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_ID = 404_2026;

function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

async function main() {
  const mode = process.argv[2] || '--apply';
  if (!['--apply', '--status', '--baseline'].includes(mode)) {
    throw new Error(`Unknown option ${mode}. Use --status, --baseline, or no option to apply.`);
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required; refusing to guess a target database.');

  const client = new Client({
    connectionString,
    ssl: /supabase\.(co|com)/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const applied = new Map((await client.query('SELECT filename, checksum FROM public.schema_migrations'))
      .rows.map((row) => [row.filename, row.checksum]));
    const migrations = listMigrations();
    const pending = migrations.filter((m) => !applied.has(m.name));

    for (const m of migrations) {
      if (applied.has(m.name) && applied.get(m.name) !== m.checksum) {
        console.warn(`[migrate] WARNING ${m.name} changed after it was applied. Write a new migration instead of editing an applied one.`);
      }
    }

    if (mode === '--status') {
      for (const m of migrations) console.log(`${applied.has(m.name) ? 'applied ' : 'PENDING '} ${m.name}`);
      console.log(`[migrate] ${migrations.length - pending.length} applied, ${pending.length} pending.`);
      return;
    }

    if (mode === '--baseline') {
      for (const m of pending) {
        await client.query('INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
        console.log(`[migrate] recorded as applied (not run): ${m.name}`);
      }
      console.log(`[migrate] Baseline complete: ${pending.length} file(s) recorded.`);
      return;
    }

    if (!pending.length) {
      console.log('[migrate] Database is up to date.');
      return;
    }
    for (const m of pending) {
      console.log(`[migrate] applying ${m.name}`);
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${m.name} failed and was rolled back: ${err.message}`);
      }
    }
    console.log(`[migrate] Applied ${pending.length} migration(s).`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[migrate] ${err.message}`);
  process.exit(1);
});
