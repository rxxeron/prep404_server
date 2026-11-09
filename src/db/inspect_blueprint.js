const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    const q1 = await pool.query(`
      SELECT 
        b.id,
        b.university_code AS "universityCode",
        b.program_title AS "programTitle",
        b.degree_name AS "degreeName",
        b.total_marks AS "totalMarks",
        b.duration_minutes AS "durationMinutes",
        b.negative_marking AS "negativeMarking",
        b.cutoff_target_percentage AS "cutoffTargetPercentage",
        b.sections,
        u.id AS "universityId",
        u.full_name AS "universityFullName",
        u.short_name AS "universityShortName",
        u.logo_url AS "logoUrl"
      FROM university_blueprints b
      LEFT JOIN universities u ON LOWER(u.code) = LOWER(b.university_code) OR LOWER(u.slug) = LOWER(b.university_code)
      ORDER BY b.university_code, b.program_title;
    `);
    console.log('Success, rows:', q1.rows.length);
  } catch (err) {
    console.error('Error detail:', err);
  } finally {
    pool.end();
  }
}

main();
