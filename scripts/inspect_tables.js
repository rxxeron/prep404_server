const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres.hrgiscymbpqatlzrefrt:Rhrakib12%40%2312@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres' });
async function check() {
  for (const t of ['users']) {
    const res = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position", [t]);
    console.log('=== ' + t + ' ===');
    console.log(res.rows.map(r => r.column_name + ' (' + r.data_type + ')').join(', '));
  }
  pool.end();
}
check().catch(e => { console.error(e); pool.end(); });
