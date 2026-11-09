import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Pool } from 'pg';
import { hashStaffPassword } from '../services/staff_credentials.service';

function readHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Run this command in an interactive terminal so the password can be entered without echo.'));
  }

  stdout.write(prompt);
  stdin.setEncoding('utf8');
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string | Buffer) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') return finish(new Error('Bootstrap cancelled.'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') {
          if (value.length) { value = value.slice(0, -1); stdout.write('\b \b'); }
        } else if (char >= ' ' && value.length < 128) {
          value += char;
          stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const prompt = createInterface({ input: stdin, output: stdout });
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
  });

  try {
    const email = (await prompt.question('Initial super-admin email: ')).trim().toLowerCase();
    if (email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address (maximum 150 characters).');
    const username = (await prompt.question('Initial super-admin username: ')).trim().toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new Error('Username must contain 3–32 lowercase letters, numbers, or underscores.');
    prompt.close();
    const password = await readHidden('Password (14–128 characters): ');
    const confirmation = await readHidden('Confirm password: ');
    if (password.length < 14 || password.length > 128) throw new Error('Password must be 14–128 characters.');
    if (password !== confirmation) throw new Error('Passwords do not match.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('prep404:first-staff-super-admin', 0))");
      const count = await client.query('SELECT count(*)::int AS count FROM public.staff_members');
      if (count.rows[0].count !== 0) throw new Error('Bootstrap is only allowed while the staff directory is empty. Use normal staff management after the first account exists.');

      const inserted = await client.query(`INSERT INTO public.staff_members (email, username, password_hash, full_name, role, is_active)
        VALUES ($1, $2, $3, $2, 'super_admin', true)
        RETURNING id`, [email, username, hashStaffPassword(password)]);
      await client.query(`INSERT INTO public.staff_audit_logs (actor_email, actor_role, action, entity_type, entity_id, metadata)
        VALUES ($1, 'super_admin', 'staff.account.bootstrap_created', 'staff_account', $2, '{"source":"one_time_cli_bootstrap"}'::jsonb)`, [email, inserted.rows[0].id]);
      await client.query('COMMIT');
      stdout.write(`Created the first managed super-admin account for ${email} (username: ${username}). Sign in through the admin panel, then provision additional staff there.\n`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  } finally {
    prompt.close();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  stdout.write(`Staff bootstrap failed: ${error instanceof Error ? error.message : 'unexpected error'}\n`);
  process.exitCode = 1;
});
