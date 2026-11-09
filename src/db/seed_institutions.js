const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const connStr = process.env.DATABASE_URL;
if (!connStr) throw new Error('DATABASE_URL is required; refusing to seed without an explicit target.');

async function seedInstitutions() {
  const client = new Client({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('[Institutions Seeder] Connected to database.');

    // 1. Apply Schema
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema_institutions.sql'), 'utf8');
    console.log('[Institutions Seeder] Applying schema_institutions.sql...');
    await client.query(schemaSql);
    console.log('[Institutions Seeder] Schema and indexes applied successfully!');

    // 2. Load Government Data
    const dataPath = path.join(__dirname, '../../../live_govt_institutions_all.json');
    if (!fs.existsSync(dataPath)) {
      throw new Error(`Data file not found at: ${dataPath}`);
    }
    const rawData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    console.log(`[Institutions Seeder] Loaded ${rawData.length} records from live government dataset.`);

    // 3. Populate Divisions
    console.log('[Institutions Seeder] Ingesting administrative divisions...');
    const uniqueDivisions = [...new Set(rawData.map(r => r.divisionName).filter(Boolean))];
    for (const div of uniqueDivisions) {
      await client.query(
        `INSERT INTO divisions (name_bn) VALUES ($1) ON CONFLICT (name_bn) DO NOTHING`,
        [div]
      );
    }
    const divRes = await client.query('SELECT id, name_bn FROM divisions');
    const divMap = new Map(divRes.rows.map(r => [r.name_bn, r.id]));

    // 4. Populate Districts
    console.log('[Institutions Seeder] Ingesting administrative districts...');
    const districtPairs = new Map();
    for (const r of rawData) {
      if (r.divisionName && r.districtName) {
        districtPairs.set(`${r.divisionName}:::${r.districtName}`, {
          divId: divMap.get(r.divisionName),
          distName: r.districtName
        });
      }
    }
    for (const { divId, distName } of districtPairs.values()) {
      await client.query(
        `INSERT INTO districts (division_id, name_bn) VALUES ($1, $2) ON CONFLICT (division_id, name_bn) DO NOTHING`,
        [divId, distName]
      );
    }
    const distRes = await client.query('SELECT id, division_id, name_bn FROM districts');
    const distMap = new Map(distRes.rows.map(r => [`${r.division_id}:::${r.name_bn}`, r.id]));

    // 5. Populate Thanas
    console.log('[Institutions Seeder] Ingesting administrative thanas...');
    const thanaPairs = new Map();
    for (const r of rawData) {
      if (r.divisionName && r.districtName && r.thanaName) {
        const divId = divMap.get(r.divisionName);
        const distId = distMap.get(`${divId}:::${r.districtName}`);
        if (distId) {
          thanaPairs.set(`${distId}:::${r.thanaName}`, {
            distId,
            thanaName: r.thanaName
          });
        }
      }
    }
    for (const { distId, thanaName } of thanaPairs.values()) {
      await client.query(
        `INSERT INTO thanas (district_id, name_bn) VALUES ($1, $2) ON CONFLICT (district_id, name_bn) DO NOTHING`,
        [distId, thanaName]
      );
    }
    const thanaRes = await client.query('SELECT id, district_id, name_bn FROM thanas');
    const thanaMap = new Map(thanaRes.rows.map(r => [`${r.district_id}:::${r.name_bn}`, r.id]));

    // 6. Ingest Institutions in Batches (Bulk Upsert)
    console.log('[Institutions Seeder] Bulk seeding institutions with boolean flags...');
    const batchSize = 1000;
    let inserted = 0;

    for (let i = 0; i < rawData.length; i += batchSize) {
      const batch = rawData.slice(i, i + batchSize);
      const values = [];
      const placeholders = [];
      let paramIdx = 1;

      for (const r of batch) {
        const divId = divMap.get(r.divisionName);
        const distId = distMap.get(`${divId}:::${r.districtName}`);
        const thanaId = thanaMap.get(`${distId}:::${r.thanaName}`);
        if (!thanaId) continue;

        const tname = (r.instituteTypeName || '').trim();
        const isBoth = tname.includes('স্কুল ও কলেজ') || tname.toUpperCase().includes('SCHOOL & COLLEGE');
        const isCollege = isBoth || tname.includes('কলেজ') || tname.toUpperCase().includes('COLLEGE');
        const isSchool = isBoth || tname.includes('স্কুল') || tname.toUpperCase().includes('SCHOOL');
        const isMadrasa = tname.includes('মাদ্রাসা') || tname.toUpperCase().includes('MADRASHA');
        const isTechnical = tname.includes('কারিগরি') || tname.toUpperCase().includes('TECHNICAL');

        values.push(
          r.eiinNo,
          r.instituteName || r.instituteNameBn || 'UNNAMED',
          r.instituteNameBn || null,
          thanaId,
          isSchool,
          isCollege,
          isMadrasa,
          isTechnical,
          r.mobile || null
        );

        placeholders.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, $${paramIdx+7}, $${paramIdx+8})`);
        paramIdx += 9;
      }

      if (placeholders.length > 0) {
        const query = `
          INSERT INTO institutions (
            eiin, name_en, name_bn, thana_id, 
            is_school, is_college, is_madrasa, is_technical, mobile_masked
          ) VALUES ${placeholders.join(', ')}
          ON CONFLICT (eiin) DO UPDATE SET
            name_en = EXCLUDED.name_en,
            name_bn = EXCLUDED.name_bn,
            thana_id = EXCLUDED.thana_id,
            is_school = EXCLUDED.is_school,
            is_college = EXCLUDED.is_college,
            is_madrasa = EXCLUDED.is_madrasa,
            is_technical = EXCLUDED.is_technical,
            mobile_masked = EXCLUDED.mobile_masked,
            updated_at = NOW();
        `;
        await client.query(query, values);
        inserted += placeholders.length;
        process.stdout.write(`\rSeeded ${inserted} / ${rawData.length} institutions...`);
      }
    }

    console.log('\n[Institutions Seeder] Complete! Verification counts:');
    const counts = await client.query(`
      SELECT 
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE is_school = TRUE AND is_college = TRUE) AS school_and_college,
        COUNT(*) FILTER (WHERE is_school = TRUE AND is_college = FALSE) AS school_only,
        COUNT(*) FILTER (WHERE is_college = TRUE AND is_school = FALSE) AS college_only,
        COUNT(*) FILTER (WHERE is_madrasa = TRUE) AS madrasa_total
      FROM institutions;
    `);
    console.table(counts.rows);

  } catch (err) {
    console.error('[Institutions Seeder] Error:', err);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  seedInstitutions();
}

module.exports = { seedInstitutions };
