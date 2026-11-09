require('dotenv').config({ path: 'server/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function createTable() {
  const client = await pool.connect();
  try {
    console.log('Creating exam_snapshots table and indexes...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS exam_snapshots (
        exam_id UUID PRIMARY KEY REFERENCES exams(id) ON DELETE CASCADE,
        slug VARCHAR(180) UNIQUE NOT NULL,
        access_key VARCHAR(64) UNIQUE NOT NULL,
        title TEXT NOT NULL,
        exam_type VARCHAR(50) NOT NULL,
        track VARCHAR(50) NOT NULL,
        duration_minutes INT NOT NULL,
        total_marks NUMERIC(6,2) NOT NULL,
        negative_mark NUMERIC(4,2) NOT NULL DEFAULT 0.25,
        question_count INT NOT NULL,
        payload_json JSONB NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        version INT DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_exam_snapshots_slug ON exam_snapshots(slug);
      CREATE INDEX IF NOT EXISTS idx_exam_snapshots_access_key ON exam_snapshots(access_key);
      CREATE INDEX IF NOT EXISTS idx_exam_snapshots_exam_type ON exam_snapshots(exam_type);
    `);
    console.log('exam_snapshots table and indexes created successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

createTable().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
