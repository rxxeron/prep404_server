const { Pool } = require('pg');
require('dotenv').config({ path: '.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    // 1. Inspect programs
    const progCols = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'programs'");
    console.log("Programs columns:", progCols.rows.map(r => `${r.column_name} (${r.data_type})`));

    const programs = await pool.query(`
      SELECT u.short_name as uni, p.name, p.degree_type, p.track_category 
      FROM programs p 
      JOIN universities u ON u.id = p.university_id 
      ORDER BY u.short_name, p.track_category
    `);
    console.log(`Total programs: ${programs.rows.length}`);
    const summary = {};
    for (const r of programs.rows) {
      if (!summary[r.uni]) summary[r.uni] = {};
      if (!summary[r.uni][r.track_category]) summary[r.uni][r.track_category] = [];
      summary[r.uni][r.track_category].push(r.name);
    }
    console.log("Summary by university & track_category:\n", JSON.stringify(summary, null, 2));

    // 2. Admission Test Patterns
    const patCols = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'admission_test_patterns'");
    console.log("admission_test_patterns columns:", patCols.rows.map(r => r.column_name));

    const patterns = await pool.query(`
      SELECT u.short_name, atp.slug, atp.pattern_name, atp.test_archetype, atp.total_marks, atp.sections 
      FROM admission_test_patterns atp
      JOIN universities u ON u.id = atp.university_id
    `);
    console.log("\nAdmission Test Patterns count:", patterns.rows.length);
    for (const pat of patterns.rows) {
      console.log(`\nPattern for ${pat.short_name} (${pat.pattern_name} / ${pat.slug}):`);
      console.log(JSON.stringify(pat.sections, null, 2));
    }

    // 3. Admission cycles
    const acCols = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'admission_cycles'");
    console.log("admission_cycles columns:", acCols.rows.map(r => r.column_name));

    const cycles = await pool.query(`
      SELECT u.short_name, ac.* 
      FROM admission_cycles ac
      JOIN universities u ON u.id = ac.university_id
      ORDER BY u.short_name, ac.exam_date ASC
      LIMIT 10
    `);
    console.log("\nAdmission Cycles:\n", cycles.rows.map(r => ({
      uni: r.short_name,
      academic_year: r.academic_year,
      season: r.season,
      exam_date: r.exam_date,
      application_deadline: r.application_deadline,
      status: r.status
    })));

  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
