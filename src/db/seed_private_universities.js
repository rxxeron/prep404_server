const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const connStr = process.env.DATABASE_URL;
if (!connStr) throw new Error('DATABASE_URL is required; refusing to seed without an explicit target.');

async function seed() {
  const client = new Client({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('[Seed Universities] Connected to PostgreSQL / Supabase.');

    // 1. Apply Pure-UUID Schema
    const schemaPath = path.join(__dirname, 'schema_private_universities.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    console.log('[Seed Universities] Applying schema_private_universities.sql (Pure UUID Relations)...');
    await client.query(schemaSql);
    console.log('[Seed Universities] Schema applied successfully.');

    await client.query('BEGIN');

    // 2. Insert Universities & map generated UUIDs
    const universities = [
      {
        slug: 'nsu',
        code: 'NSU',
        full_name: 'North South University',
        short_name: 'North South',
        academic_system: 'trimester',
        campus_location: 'Plot 15, Block B, Bashundhara R/A, Dhaka-1229',
        website_url: 'https://www.northsouth.edu',
        admission_portal_url: 'https://admissions.northsouth.edu'
      },
      {
        slug: 'brac',
        code: 'BRACU',
        full_name: 'BRAC University',
        short_name: 'BRAC University',
        academic_system: 'trimester',
        campus_location: 'Kha 224, Bir Uttam Rafiqul Islam Avenue, Merul Badda, Dhaka 1212',
        website_url: 'https://www.bracu.ac.bd',
        admission_portal_url: 'https://admissions.bracu.ac.bd'
      },
      {
        slug: 'ewu',
        code: 'EWU',
        full_name: 'East West University',
        short_name: 'East West',
        academic_system: 'trimester',
        campus_location: 'A/2, Jahurul Islam Avenue, Jahurul Islam City, Aftabnagar, Dhaka-1212',
        website_url: 'https://www.ewubd.edu',
        admission_portal_url: 'https://admission.ewubd.edu'
      },
      {
        slug: 'aust',
        code: 'AUST',
        full_name: 'Ahsanullah University of Science and Technology',
        short_name: 'Ahsanullah',
        academic_system: 'semester',
        campus_location: '141 & 142, Love Road, Tejgaon Industrial Area, Dhaka-1208',
        website_url: 'https://www.aust.edu',
        admission_portal_url: 'https://admission.aust.edu'
      },
      {
        slug: 'aiub',
        code: 'AIUB',
        full_name: 'American International University-Bangladesh',
        short_name: 'AIUB',
        academic_system: 'trimester',
        campus_location: '408/1, Kuratoli, Khilkhet, Dhaka 1229',
        website_url: 'https://www.aiub.edu',
        admission_portal_url: 'https://admission.aiub.edu'
      },
      {
        slug: 'uiu',
        code: 'UIU',
        full_name: 'United International University',
        short_name: 'UIU',
        academic_system: 'trimester',
        campus_location: 'United City, Madani Avenue, Badda, Dhaka 1212',
        website_url: 'https://www.uiu.ac.bd',
        admission_portal_url: 'https://admission.uiu.ac.bd'
      },
      {
        slug: 'uap',
        code: 'UAP',
        full_name: 'University of Asia Pacific',
        short_name: 'UAP',
        academic_system: 'semester',
        campus_location: '74/A, Green Road, Farmgate, Dhaka - 1205',
        website_url: 'https://www.uap-bd.edu',
        admission_portal_url: 'https://admission.uap-bd.edu'
      },
      {
        slug: 'iub',
        code: 'IUB',
        full_name: 'Independent University, Bangladesh',
        short_name: 'IUB',
        academic_system: 'trimester',
        campus_location: 'Plot 16, Block B, Aftabuddin Ahmed Road, Bashundhara R/A, Dhaka-1229',
        website_url: 'https://www.iub.edu.bd',
        admission_portal_url: 'https://admission.iub.edu.bd'
      }
    ];

    const uniIdMap = {}; // slug -> UUID

    for (const u of universities) {
      const res = await client.query(`
        INSERT INTO public.universities (slug, code, full_name, short_name, academic_system, campus_location, website_url, admission_portal_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id;
      `, [u.slug, u.code, u.full_name, u.short_name, u.academic_system, u.campus_location, u.website_url, u.admission_portal_url]);
      uniIdMap[u.slug] = res.rows[0].id;
    }
    console.log(`[Seed Universities] Seeded ${Object.keys(uniIdMap).length} universities with UUIDs.`);

    // 3. Insert Academic Units
    const academicUnits = [
      // NSU
      { uniSlug: 'nsu', slug: 'sbe', type: 'school', name: 'School of Business and Economics', short_code: 'SBE' },
      { uniSlug: 'nsu', slug: 'seps', type: 'school', name: 'School of Engineering and Physical Sciences', short_code: 'SEPS' },
      { uniSlug: 'nsu', slug: 'shls', type: 'school', name: 'School of Health and Life Sciences', short_code: 'SHLS' },
      { uniSlug: 'nsu', slug: 'shss', type: 'school', name: 'School of Humanities and Social Sciences', short_code: 'SHSS' },
      // BracU
      { uniSlug: 'brac', slug: 'bbs', type: 'school', name: 'BRAC Business School', short_code: 'BBS' },
      { uniSlug: 'brac', slug: 'sds', type: 'school', name: 'School of Data and Sciences', short_code: 'SDS' },
      { uniSlug: 'brac', slug: 'soe', type: 'school', name: 'School of Engineering', short_code: 'SoE' },
      { uniSlug: 'brac', slug: 'shss', type: 'school', name: 'School of Humanities and Social Sciences', short_code: 'SHSS' },
      { uniSlug: 'brac', slug: 'sol', type: 'school', name: 'School of Law', short_code: 'SoL' },
      { uniSlug: 'brac', slug: 'sphr', type: 'school', name: 'School of Pharmacy', short_code: 'SPHR' },
      { uniSlug: 'brac', slug: 'arch', type: 'department', name: 'Department of Architecture', short_code: 'ARC' },
      // EWU
      { uniSlug: 'ewu', slug: 'fbe', type: 'faculty', name: 'Faculty of Business and Economics', short_code: 'FBE' },
      { uniSlug: 'ewu', slug: 'fse', type: 'faculty', name: 'Faculty of Sciences and Engineering', short_code: 'FSE' },
      { uniSlug: 'ewu', slug: 'flass', type: 'faculty', name: 'Faculty of Liberal Arts and Social Sciences', short_code: 'FLASS' },
      // AUST
      { uniSlug: 'aust', slug: 'fet', type: 'faculty', name: 'Faculty of Engineering & Technology', short_code: 'FET' },
      { uniSlug: 'aust', slug: 'fap', type: 'faculty', name: 'Faculty of Architecture & Planning', short_code: 'FAP' },
      { uniSlug: 'aust', slug: 'fbss', type: 'faculty', name: 'Faculty of Business and Social Sciences', short_code: 'FBSS' },
      // AIUB
      { uniSlug: 'aiub', slug: 'fba', type: 'faculty', name: 'Faculty of Business Administration', short_code: 'FBA' },
      { uniSlug: 'aiub', slug: 'fst', type: 'faculty', name: 'Faculty of Science & Technology', short_code: 'FST' },
      { uniSlug: 'aiub', slug: 'fe', type: 'faculty', name: 'Faculty of Engineering', short_code: 'FE' },
      { uniSlug: 'aiub', slug: 'fhls', type: 'faculty', name: 'Faculty of Health & Life Sciences', short_code: 'FHLS' },
      { uniSlug: 'aiub', slug: 'fass', type: 'faculty', name: 'Faculty of Arts & Social Sciences', short_code: 'FASS' },
      // UIU
      { uniSlug: 'uiu', slug: 'sobe', type: 'school', name: 'School of Business and Economics', short_code: 'SOBE' },
      { uniSlug: 'uiu', slug: 'sose', type: 'school', name: 'School of Science and Engineering', short_code: 'SOSE' },
      { uniSlug: 'uiu', slug: 'slhs', type: 'school', name: 'School of Life and Health Sciences', short_code: 'SLHS' },
      { uniSlug: 'uiu', slug: 'shss', type: 'school', name: 'School of Humanities and Social Sciences', short_code: 'SHSS' },
      // UAP
      { uniSlug: 'uap', slug: 'eng', type: 'school', name: 'School of Engineering', short_code: 'SOE' },
      { uniSlug: 'uap', slug: 'arch', type: 'school', name: 'School of Environmental Sciences and Design', short_code: 'SESD' },
      { uniSlug: 'uap', slug: 'bus', type: 'school', name: 'School of Business', short_code: 'SOB' },
      { uniSlug: 'uap', slug: 'hss', type: 'school', name: 'School of Humanities and Social Sciences', short_code: 'SHSS' },
      { uniSlug: 'uap', slug: 'med', type: 'school', name: 'School of Medicine / Pharmacy', short_code: 'SOM' },
      // IUB
      { uniSlug: 'iub', slug: 'sbe', type: 'school', name: 'School of Business and Entrepreneurship', short_code: 'SBE' },
      { uniSlug: 'iub', slug: 'sets', type: 'school', name: 'School of Engineering, Physical Sciences & Technology', short_code: 'SETS' },
      { uniSlug: 'iub', slug: 'spph', type: 'school', name: 'School of Pharmacy and Public Health', short_code: 'SPPH' },
      { uniSlug: 'iub', slug: 'sels', type: 'school', name: 'School of Environment and Life Sciences', short_code: 'SELS' },
      { uniSlug: 'iub', slug: 'slass', type: 'school', name: 'School of Liberal Arts and Social Sciences', short_code: 'SLASS' }
    ];

    const unitIdMap = {}; // `${uniSlug}:${unitSlug}` -> UUID

    for (const au of academicUnits) {
      const uniUuid = uniIdMap[au.uniSlug];
      const res = await client.query(`
        INSERT INTO public.academic_units (university_id, slug, unit_type, name, short_code)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id;
      `, [uniUuid, au.slug, au.type, au.name, au.short_code]);
      unitIdMap[`${au.uniSlug}:${au.slug}`] = res.rows[0].id;
    }
    console.log(`[Seed Universities] Seeded ${Object.keys(unitIdMap).length} academic units with UUIDs.`);

    // 4. Insert Programs & Fee Structures
    const programsData = [
      // NSU
      {
        uniSlug: 'nsu', unitSlug: 'sbe', slug: 'bba', name: 'Bachelor of Business Administration (BBA)',
        category: 'business', credits: 130, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 10000, creditFee: 8000, semFee: 0,
        recurring: 8000, extra: { rfid_card: 1000 }, estTotal: 1141000
      },
      {
        uniSlug: 'nsu', unitSlug: 'seps', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)',
        category: 'engineering', credits: 148, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 10000, creditFee: 8000, semFee: 0,
        recurring: 10500, extra: { rfid_card: 1000 }, estTotal: 1346000
      },
      {
        uniSlug: 'nsu', unitSlug: 'seps', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)',
        category: 'engineering', credits: 144, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 10000, creditFee: 8000, semFee: 0,
        recurring: 10500, extra: { rfid_card: 1000 }, estTotal: 1314000
      },
      {
        uniSlug: 'nsu', unitSlug: 'shls', slug: 'pharm', name: 'Bachelor of Pharmacy Professional (B.Pharm)',
        category: 'pharmacy', credits: 164, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 10000, creditFee: 8000, semFee: 0,
        recurring: 11500, extra: { rfid_card: 1000 }, estTotal: 1439000
      },
      {
        uniSlug: 'nsu', unitSlug: 'seps', slug: 'arch', name: 'Bachelor of Architecture (B.Arch)',
        category: 'architecture', credits: 189, duration: 5.0,
        billing: 'per_credit', admFee: 25000, caution: 10000, creditFee: 8000, semFee: 0,
        recurring: 10500, extra: { rfid_card: 1000 }, estTotal: 1673500
      },
      {
        uniSlug: 'nsu', unitSlug: 'shss', slug: 'llb', name: 'Bachelor of Laws (LL.B. Hons)',
        category: 'law', credits: 130, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 10000, creditFee: 8000, semFee: 0,
        recurring: 8000, extra: { rfid_card: 1000 }, estTotal: 1141000
      },

      // BracU
      {
        uniSlug: 'brac', unitSlug: 'bbs', slug: 'bba', name: 'Bachelor of Business Administration (BBA)',
        category: 'business', credits: 130, duration: 4.0,
        billing: 'per_credit', admFee: 33900, caution: 0, creditFee: 8250, semFee: 0,
        recurring: 10520, extra: { library_fee: 2500, residential_semester: 90000 }, estTotal: 1285140
      },
      {
        uniSlug: 'brac', unitSlug: 'sds', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)',
        category: 'engineering', credits: 140, duration: 4.0,
        billing: 'per_credit', admFee: 33900, caution: 0, creditFee: 8250, semFee: 0,
        recurring: 14175, extra: { library_fee: 2500, residential_semester: 90000 }, estTotal: 1391500
      },
      {
        uniSlug: 'brac', unitSlug: 'soe', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)',
        category: 'engineering', credits: 140, duration: 4.0,
        billing: 'per_credit', admFee: 33900, caution: 0, creditFee: 8250, semFee: 0,
        recurring: 10520, extra: { library_fee: 2500, residential_semester: 90000 }, estTotal: 1347640
      },
      {
        uniSlug: 'brac', unitSlug: 'sphr', slug: 'pharm', name: 'Bachelor of Pharmacy (B.Pharm)',
        category: 'pharmacy', credits: 164, duration: 4.0,
        billing: 'per_credit', admFee: 33900, caution: 0, creditFee: 8250, semFee: 0,
        recurring: 15750, extra: { library_fee: 2500, residential_semester: 90000 }, estTotal: 1565400
      },
      {
        uniSlug: 'brac', unitSlug: 'sol', slug: 'llb', name: 'Bachelor of Laws (LL.B. Hons)',
        category: 'law', credits: 135, duration: 4.0,
        billing: 'per_credit', admFee: 33900, caution: 0, creditFee: 8800, semFee: 0,
        recurring: 15750, extra: { library_fee: 2500, residential_semester: 90000 }, estTotal: 1400400
      },

      // EWU
      {
        uniSlug: 'ewu', unitSlug: 'fbe', slug: 'bba', name: 'Bachelor of Business Administration (BBA)',
        category: 'business', credits: 130, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 6500, semFee: 0,
        recurring: 5500, extra: {}, estTotal: 936000
      },
      {
        uniSlug: 'ewu', unitSlug: 'fse', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)',
        category: 'engineering', credits: 140, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 6500, semFee: 0,
        recurring: 7000, extra: {}, estTotal: 1019000
      },
      {
        uniSlug: 'ewu', unitSlug: 'fse', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)',
        category: 'engineering', credits: 140, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 6500, semFee: 0,
        recurring: 7000, extra: {}, estTotal: 1019000
      },
      {
        uniSlug: 'ewu', unitSlug: 'fse', slug: 'pharm', name: 'Bachelor of Pharmacy (B.Pharm)',
        category: 'pharmacy', credits: 158, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 7000, semFee: 0,
        recurring: 9000, extra: {}, estTotal: 1229000
      },
      {
        uniSlug: 'ewu', unitSlug: 'flass', slug: 'llb', name: 'Bachelor of Laws (LL.B. Hons)',
        category: 'law', credits: 130, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 6500, semFee: 0,
        recurring: 7000, extra: {}, estTotal: 954000
      },

      // AUST
      {
        uniSlug: 'aust', unitSlug: 'fet', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)',
        category: 'engineering', credits: 160, duration: 4.0,
        billing: 'flat_semester', admFee: 33550, caution: 0, creditFee: null, semFee: 110550,
        recurring: 0, extra: {}, estTotal: 917950
      },
      {
        uniSlug: 'aust', unitSlug: 'fet', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)',
        category: 'engineering', credits: 160, duration: 4.0,
        billing: 'flat_semester', admFee: 33550, caution: 0, creditFee: null, semFee: 110550,
        recurring: 0, extra: {}, estTotal: 917950
      },
      {
        uniSlug: 'aust', unitSlug: 'fet', slug: 'ce', name: 'B.Sc. in Civil Engineering (CE)',
        category: 'engineering', credits: 160, duration: 4.0,
        billing: 'flat_semester', admFee: 33550, caution: 0, creditFee: null, semFee: 110550,
        recurring: 0, extra: {}, estTotal: 917950
      },
      {
        uniSlug: 'aust', unitSlug: 'fet', slug: 'te', name: 'B.Sc. in Textile Engineering (TE)',
        category: 'engineering', credits: 160, duration: 4.0,
        billing: 'flat_semester', admFee: 33550, caution: 0, creditFee: null, semFee: 110550,
        recurring: 0, extra: {}, estTotal: 917950
      },
      {
        uniSlug: 'aust', unitSlug: 'fap', slug: 'arch', name: 'Bachelor of Architecture (B.Arch)',
        category: 'architecture', credits: 195, duration: 5.0,
        billing: 'flat_semester', admFee: 33550, caution: 0, creditFee: null, semFee: 110550,
        recurring: 0, extra: {}, estTotal: 1139050
      },
      {
        uniSlug: 'aust', unitSlug: 'fbss', slug: 'bba', name: 'Bachelor of Business Administration (BBA)',
        category: 'business', credits: 130, duration: 4.0,
        billing: 'flat_semester', admFee: 21450, caution: 0, creditFee: null, semFee: 89045,
        recurring: 0, extra: { optional_transport_per_sem: 2000 }, estTotal: 733810
      },

      // AIUB
      {
        uniSlug: 'aiub', unitSlug: 'fst', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)',
        category: 'engineering', credits: 148, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 8500, semFee: 0,
        recurring: 12500, extra: { verification_fee: 2000 }, estTotal: 1435000
      },
      {
        uniSlug: 'aiub', unitSlug: 'fba', slug: 'bba', name: 'Bachelor of Business Administration (BBA)',
        category: 'business', credits: 130, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 8000, semFee: 0,
        recurring: 12500, extra: { verification_fee: 2000 }, estTotal: 1217000
      },
      {
        uniSlug: 'aiub', unitSlug: 'fe', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)',
        category: 'engineering', credits: 144, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 7500, semFee: 0,
        recurring: 12500, extra: { verification_fee: 2000 }, estTotal: 1257000
      },
      {
        uniSlug: 'aiub', unitSlug: 'fhls', slug: 'pharm', name: 'Bachelor of Pharmacy (B.Pharm)',
        category: 'pharmacy', credits: 160, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 8500, semFee: 0,
        recurring: 12500, extra: { verification_fee: 2000 }, estTotal: 1487000
      },
      {
        uniSlug: 'aiub', unitSlug: 'fass', slug: 'llb', name: 'Bachelor of Laws (LL.B.)',
        category: 'law', credits: 135, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 8500, semFee: 0,
        recurring: 12500, extra: { verification_fee: 2000 }, estTotal: 1324500
      },

      // UIU
      {
        uniSlug: 'uiu', unitSlug: 'sobe', slug: 'bba', name: 'Bachelor of Business Administration (BBA)',
        category: 'business', credits: 125, duration: 4.0,
        billing: 'per_credit', admFee: 20000, caution: 2000, creditFee: 6500, semFee: 0,
        recurring: 6500, extra: {}, estTotal: 910500
      },
      {
        uniSlug: 'uiu', unitSlug: 'sose', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)',
        category: 'engineering', credits: 141, duration: 4.0,
        billing: 'per_credit', admFee: 20000, caution: 2000, creditFee: 6500, semFee: 0,
        recurring: 6500, extra: {}, estTotal: 1014500
      },
      {
        uniSlug: 'uiu', unitSlug: 'sose', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)',
        category: 'engineering', credits: 140, duration: 4.0,
        billing: 'per_credit', admFee: 20000, caution: 2000, creditFee: 6500, semFee: 0,
        recurring: 6500, extra: {}, estTotal: 1008000
      },
      {
        uniSlug: 'uiu', unitSlug: 'slhs', slug: 'pharm', name: 'Bachelor of Pharmacy (B.Pharm)',
        category: 'pharmacy', credits: 160, duration: 4.0,
        billing: 'per_credit', admFee: 20000, caution: 2000, creditFee: 6500, semFee: 0,
        recurring: 9750, extra: {}, estTotal: 1140000
      },

      // UAP
      {
        uniSlug: 'uap', unitSlug: 'eng', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)',
        category: 'engineering', credits: 153, duration: 4.0,
        billing: 'flat_semester', admFee: 18500, caution: 3000, creditFee: null, semFee: 100000,
        recurring: 0, extra: {}, estTotal: 832700
      },
      {
        uniSlug: 'uap', unitSlug: 'bus', slug: 'bba', name: 'Bachelor of Business Administration (BBA)',
        category: 'business', credits: 130, duration: 4.0,
        billing: 'flat_semester', admFee: 18500, caution: 3000, creditFee: null, semFee: 85000,
        recurring: 0, extra: {}, estTotal: 722700
      },
      {
        uniSlug: 'uap', unitSlug: 'eng', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)',
        category: 'engineering', credits: 151, duration: 4.0,
        billing: 'flat_semester', admFee: 18500, caution: 3000, creditFee: null, semFee: 100000,
        recurring: 0, extra: {}, estTotal: 832700
      },
      {
        uniSlug: 'uap', unitSlug: 'med', slug: 'pharm', name: 'Bachelor of Pharmacy (B.Pharm Hons)',
        category: 'pharmacy', credits: 162, duration: 4.0,
        billing: 'flat_semester', admFee: 18500, caution: 3000, creditFee: null, semFee: 150000,
        recurring: 0, extra: {}, estTotal: 1233200
      },
      {
        uniSlug: 'uap', unitSlug: 'hss', slug: 'llb', name: 'Bachelor of Laws (LL.B. Hons)',
        category: 'law', credits: 144, duration: 4.0,
        billing: 'flat_semester', admFee: 18500, caution: 3000, creditFee: null, semFee: 100000,
        recurring: 0, extra: {}, estTotal: 836700
      },
      {
        uniSlug: 'uap', unitSlug: 'arch', slug: 'arch', name: 'Bachelor of Architecture (B.Arch)',
        category: 'architecture', credits: 182, duration: 5.0,
        billing: 'flat_semester', admFee: 18500, caution: 3000, creditFee: null, semFee: 115000,
        recurring: 0, extra: {}, estTotal: 1182700
      },

      // IUB
      {
        uniSlug: 'iub', unitSlug: 'sbe', slug: 'bba', name: 'Bachelor of Business Administration (BBA)',
        category: 'business', credits: 130, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 6500, semFee: 0,
        recurring: 8000, extra: {}, estTotal: 966000
      },
      {
        uniSlug: 'iub', unitSlug: 'sets', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)',
        category: 'engineering', credits: 140, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 6500, semFee: 0,
        recurring: 8000, extra: {}, estTotal: 1031000
      },
      {
        uniSlug: 'iub', unitSlug: 'sets', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)',
        category: 'engineering', credits: 140, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 6500, semFee: 0,
        recurring: 8000, extra: {}, estTotal: 1031000
      },
      {
        uniSlug: 'iub', unitSlug: 'spph', slug: 'pharm', name: 'Bachelor of Pharmacy (B.Pharm Professional)',
        category: 'pharmacy', credits: 160, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 7500, semFee: 0,
        recurring: 12000, extra: {}, estTotal: 1369000
      },
      {
        uniSlug: 'iub', unitSlug: 'slass', slug: 'llb', name: 'Bachelor of Laws (LL.B. Hons)',
        category: 'law', credits: 135, duration: 4.0,
        billing: 'per_credit', admFee: 25000, caution: 0, creditFee: 7500, semFee: 0,
        recurring: 12000, extra: {}, estTotal: 1181500
      }
    ];

    const programIdMap = {}; // `${uniSlug}:${slug}` -> UUID

    for (const p of programsData) {
      const uniUuid = uniIdMap[p.uniSlug];
      const unitUuid = unitIdMap[`${p.uniSlug}:${p.unitSlug}`];

      const res = await client.query(`
        INSERT INTO public.programs (university_id, academic_unit_id, slug, name, degree_type, track_category, total_credits, duration_years)
        VALUES ($1, $2, $3, $4, 'bachelor', $5, $6, $7)
        RETURNING id;
      `, [uniUuid, unitUuid, p.slug, p.name, p.category, p.credits, p.duration]);

      const programUuid = res.rows[0].id;
      programIdMap[`${p.uniSlug}:${p.slug}`] = programUuid;

      await client.query(`
        INSERT INTO public.program_fee_structures (
          program_id, billing_model, admission_fee_onetime, caution_deposit_refundable,
          tuition_per_credit, semester_fixed_tuition, recurring_term_fees, mandatory_extra_fees, estimated_total_cost
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
      `, [programUuid, p.billing, p.admFee, p.caution, p.creditFee, p.semFee, p.recurring, JSON.stringify(p.extra), p.estTotal]);
    }
    console.log(`[Seed Universities] Seeded ${Object.keys(programIdMap).length} programs & fee structures with UUIDs.`);

    // 5. Insert Admission Test Patterns
    const patterns = [
      {
        uniSlug: 'nsu',
        slug: 'eng-arch',
        name: 'NSU Engineering & Architecture Admission Test',
        archetype: 'sat_aptitude',
        marks: 100,
        duration: 120,
        neg: false,
        negPenalty: 0.0,
        viva: false,
        directCriteria: { sat_math_min: 650, sat_total_min: 1200 },
        sections: [
          { name: 'General English', marks: 30, questions: 30, topics: ['Grammar', 'Reading Comprehension', 'Vocabulary'] },
          { name: 'Quantitative Math', marks: 40, questions: 40, topics: ['Algebra', 'Arithmetic', 'Geometry', 'Word Problems'] },
          { name: 'Higher Math', marks: 30, questions: 30, topics: ['Calculus', 'Trigonometry', 'Coordinate Geometry', 'Vectors'] }
        ]
      },
      {
        uniSlug: 'nsu',
        slug: 'bba-law',
        name: 'NSU Business & Economics Admission Test',
        archetype: 'sat_aptitude',
        marks: 100,
        duration: 120,
        neg: false,
        negPenalty: 0.0,
        viva: false,
        directCriteria: { sat_total_min: 1150 },
        sections: [
          { name: 'General English', marks: 40, questions: 40, topics: ['Grammar', 'Reading Comprehension', 'Sentence Correction'] },
          { name: 'Quantitative Math', marks: 50, questions: 50, topics: ['Basic Algebra', 'Ratios & Percentages', 'Data Interpretation'] },
          { name: 'Essay / Writing', marks: 10, type: 'written', topics: ['Argumentative Essay'] }
        ]
      },
      {
        uniSlug: 'brac',
        slug: 'general',
        name: 'BRAC University Standard Admission Test & Interview',
        archetype: 'hybrid_viva',
        marks: 100,
        duration: 120,
        neg: false,
        negPenalty: 0.0,
        viva: true,
        directCriteria: { sat_total_min: 1200 },
        sections: [
          { name: 'English Proficiency', marks: 40, questions: 40, topics: ['Comprehension', 'Syntax', 'Lexical Resource'] },
          { name: 'Mathematics', marks: 40, questions: 40, topics: ['General & Advanced Math'] },
          { name: 'Viva Voce', marks: 20, topics: ['Communication', 'Subject Aptitude'] }
        ]
      },
      {
        uniSlug: 'aust',
        slug: 'eng',
        name: 'AUST Engineering Units Admission Test (Rigorous HSC Focus)',
        archetype: 'nctb_science',
        marks: 200,
        duration: 120,
        neg: true,
        negPenalty: 0.25,
        viva: false,
        directCriteria: {},
        sections: [
          { name: 'Higher Mathematics', marks: 70, topics: ['Calculus', 'Trig', 'Matrices', 'Integration'] },
          { name: 'Physics', marks: 60, topics: ['Mechanics', 'Thermodynamics', 'Electricity', 'Optics'] },
          { name: 'Chemistry', marks: 40, topics: ['Organic Chemistry', 'Periodic Table', 'Stoichiometry'] },
          { name: 'English', marks: 30, topics: ['Vocabulary', 'Grammar'] }
        ]
      },
      {
        uniSlug: 'aiub',
        slug: 'eng',
        name: 'AIUB Engineering & Science Written Exam & Viva',
        archetype: 'hybrid_viva',
        marks: 100,
        duration: 90,
        neg: false,
        negPenalty: 0.0,
        viva: true,
        directCriteria: {},
        sections: [
          { name: 'English', marks: 30, topics: ['Grammar', 'Comprehension'] },
          { name: 'Mathematics', marks: 40, topics: ['General Math', 'Intermediate Higher Math'] },
          { name: 'Physics / Science', marks: 20, topics: ['Basic Physics & Technology'] },
          { name: 'Viva Voce', marks: 10, topics: ['Personality & Academic Interest'] }
        ]
      },
      {
        uniSlug: 'uiu',
        slug: 'standard',
        name: 'UIU Admission Test & Direct Admission Scheme',
        archetype: 'sat_aptitude',
        marks: 100,
        duration: 90,
        neg: false,
        negPenalty: 0.0,
        viva: false,
        directCriteria: { hsc_gpa_min: 5.00, sat_min: 1100 },
        sections: [
          { name: 'English', marks: 40, topics: ['Grammar', 'Vocabulary', 'Comprehension'] },
          { name: 'Mathematics', marks: 60, topics: ['Algebra', 'Geometry', 'Quantitative Problem Solving'] }
        ]
      },
      {
        uniSlug: 'uap',
        slug: 'standard',
        name: 'UAP Written Assessment & Viva',
        archetype: 'hybrid_viva',
        marks: 100,
        duration: 90,
        neg: false,
        negPenalty: 0.0,
        viva: true,
        directCriteria: { ssc_hsc_combined_gpa: 8.00 },
        sections: [
          { name: 'English', marks: 35, topics: ['Grammar', 'Sentence Structure'] },
          { name: 'Subject Math/Science', marks: 50, topics: ['Analytical & Computational Aptitude'] },
          { name: 'Viva Voce', marks: 15, topics: ['Oral Interview'] }
        ]
      },
      {
        uniSlug: 'iub',
        slug: 'standard',
        name: 'IUB Undergraduate Written Aptitude Test',
        archetype: 'sat_aptitude',
        marks: 100,
        duration: 100,
        neg: false,
        negPenalty: 0.0,
        viva: false,
        directCriteria: { sat_min: 1150 },
        sections: [
          { name: 'English Proficiency', marks: 45, topics: ['Reading', 'Grammar Usage', 'Vocabulary'] },
          { name: 'Quantitative Aptitude', marks: 45, topics: ['Algebra', 'Arithmetic Reasoning'] },
          { name: 'General Awareness', marks: 10, topics: ['Logic & Current Affairs'] }
        ]
      }
    ];

    const patternIdMap = {}; // `${uniSlug}:${slug}` -> UUID

    for (const pat of patterns) {
      const uniUuid = uniIdMap[pat.uniSlug];
      const res = await client.query(`
        INSERT INTO public.admission_test_patterns (
          university_id, slug, pattern_name, test_archetype, total_marks, duration_minutes,
          has_negative_marking, negative_marking_penalty, has_viva, direct_admission_criteria, sections
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id;
      `, [
        uniUuid, pat.slug, pat.name, pat.archetype, pat.marks, pat.duration,
        pat.neg, pat.negPenalty, pat.viva, JSON.stringify(pat.directCriteria), JSON.stringify(pat.sections)
      ]);
      patternIdMap[`${pat.uniSlug}:${pat.slug}`] = res.rows[0].id;
    }
    console.log(`[Seed Universities] Seeded ${Object.keys(patternIdMap).length} test patterns with UUIDs.`);

    // 6. Program-to-Pattern Mappings (UUID to UUID)
    const ppmMappings = [
      { progKey: 'nsu:cse', patKey: 'nsu:eng-arch' },
      { progKey: 'nsu:eee', patKey: 'nsu:eng-arch' },
      { progKey: 'nsu:arch', patKey: 'nsu:eng-arch' },
      { progKey: 'nsu:bba', patKey: 'nsu:bba-law' },
      { progKey: 'nsu:llb', patKey: 'nsu:bba-law' },
      { progKey: 'brac:cse', patKey: 'brac:general' },
      { progKey: 'brac:bba', patKey: 'brac:general' },
      { progKey: 'brac:eee', patKey: 'brac:general' },
      { progKey: 'brac:pharm', patKey: 'brac:general' },
      { progKey: 'brac:llb', patKey: 'brac:general' },
      { progKey: 'aust:cse', patKey: 'aust:eng' },
      { progKey: 'aust:eee', patKey: 'aust:eng' },
      { progKey: 'aust:ce', patKey: 'aust:eng' },
      { progKey: 'aust:te', patKey: 'aust:eng' },
      { progKey: 'aiub:cse', patKey: 'aiub:eng' },
      { progKey: 'aiub:eee', patKey: 'aiub:eng' },
      { progKey: 'uiu:cse', patKey: 'uiu:standard' },
      { progKey: 'uiu:bba', patKey: 'uiu:standard' },
      { progKey: 'uap:cse', patKey: 'uap:standard' },
      { progKey: 'uap:bba', patKey: 'uap:standard' },
      { progKey: 'iub:cse', patKey: 'iub:standard' },
      { progKey: 'iub:bba', patKey: 'iub:standard' }
    ];

    for (const ppm of ppmMappings) {
      const progUuid = programIdMap[ppm.progKey];
      const patUuid = patternIdMap[ppm.patKey];
      if (progUuid && patUuid) {
        await client.query(`
          INSERT INTO public.program_pattern_mappings (program_id, pattern_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING;
        `, [progUuid, patUuid]);
      }
    }
    console.log(`[Seed Universities] Seeded ${ppmMappings.length} program-pattern junction links with UUIDs.`);

    // 7. Insert Admission Cycles
    const admissionCycles = [
      // NSU
      { uniSlug: 'nsu', season: 'Spring', year: 2026, slot: 1, appDeadline: '2025-11-20T23:59:59+06:00', examDate: '2025-11-29', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'nsu', season: 'Summer', year: 2026, slot: 1, appDeadline: '2026-04-02T23:59:59+06:00', examDate: '2026-04-11', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'nsu', season: 'Fall', year: 2026, slot: 1, appDeadline: '2026-07-25T23:59:59+06:00', examDate: '2026-08-01', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'nsu', season: 'Spring', year: 2027, slot: 1, appDeadline: '2026-11-20T23:59:59+06:00', examDate: '2026-11-28', time: '10:00 AM', status: 'upcoming' },

      // BRACU
      { uniSlug: 'brac', season: 'Spring', year: 2026, slot: 1, appDeadline: '2026-01-03T23:59:59+06:00', examDate: '2026-01-09', time: '09:30 AM', status: 'completed' },
      { uniSlug: 'brac', season: 'Fall', year: 2026, slot: 1, appDeadline: '2026-08-01T23:59:59+06:00', examDate: '2026-08-07', time: '09:30 AM', status: 'completed' },
      { uniSlug: 'brac', season: 'Spring', year: 2027, slot: 1, appDeadline: '2027-01-02T23:59:59+06:00', examDate: '2027-01-08', time: '09:30 AM', status: 'upcoming' },

      // EWU
      { uniSlug: 'ewu', season: 'Spring', year: 2026, slot: 1, appDeadline: '2025-12-02T23:59:59+06:00', examDate: '2025-12-07', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'ewu', season: 'Summer', year: 2026, slot: 1, appDeadline: '2026-04-12T23:59:59+06:00', examDate: '2026-04-18', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'ewu', season: 'Fall', year: 2026, slot: 1, appDeadline: '2026-08-10T23:59:59+06:00', examDate: '2026-08-14', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'ewu', season: 'Spring', year: 2027, slot: 1, appDeadline: '2026-12-09T23:59:59+06:00', examDate: '2026-12-12', time: '10:00 AM', status: 'upcoming' },

      // AUST
      { uniSlug: 'aust', season: 'Fall', year: 2025, slot: 1, appDeadline: '2025-02-28T23:59:59+06:00', examDate: '2025-03-08', time: '09:30 AM', status: 'completed' },
      { uniSlug: 'aust', season: 'Spring', year: 2026, slot: 1, appDeadline: '2026-09-18T23:59:59+06:00', examDate: '2026-09-26', time: '09:30 AM', status: 'completed' },
      { uniSlug: 'aust', season: 'Fall', year: 2026, slot: 1, appDeadline: '2027-02-27T23:59:59+06:00', examDate: '2027-03-06', time: '09:30 AM', status: 'upcoming' },

      // AIUB
      { uniSlug: 'aiub', season: 'Spring', year: 2026, slot: 1, appDeadline: '2025-11-20T23:59:59+06:00', examDate: '2025-11-26', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'aiub', season: 'Spring', year: 2026, slot: 2, appDeadline: '2026-01-15T23:59:59+06:00', examDate: '2026-01-20', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'aiub', season: 'Summer', year: 2026, slot: 1, appDeadline: '2026-04-03T23:59:59+06:00', examDate: '2026-04-09', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'aiub', season: 'Spring', year: 2027, slot: 1, appDeadline: '2026-11-23T14:00:00+06:00', examDate: '2026-11-26', time: '10:00 AM', status: 'upcoming' },

      // UIU
      { uniSlug: 'uiu', season: 'Spring', year: 2026, slot: 1, appDeadline: '2026-01-05T23:59:59+06:00', examDate: '2026-01-09', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'uiu', season: 'Summer', year: 2026, slot: 1, appDeadline: '2026-04-20T23:59:59+06:00', examDate: '2026-04-24', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'uiu', season: 'Fall', year: 2026, slot: 1, appDeadline: '2026-08-15T23:59:59+06:00', examDate: '2026-08-21', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'uiu', season: 'Spring', year: 2027, slot: 1, appDeadline: '2027-01-04T23:59:59+06:00', examDate: '2027-01-08', time: '10:00 AM', status: 'upcoming' },

      // UAP
      { uniSlug: 'uap', season: 'Fall', year: 2026, slot: 1, appDeadline: '2026-11-06T23:59:59+06:00', examDate: '2026-11-09', time: '11:00 AM', status: 'upcoming' },
      { uniSlug: 'uap', season: 'Fall', year: 2026, slot: 2, appDeadline: '2026-12-04T23:59:59+06:00', examDate: '2026-12-07', time: '09:30 AM', status: 'upcoming' },
      { uniSlug: 'uap', season: 'Spring', year: 2027, slot: 1, appDeadline: '2027-04-25T23:59:59+06:00', examDate: '2027-05-08', time: '10:00 AM', status: 'upcoming' },

      // IUB
      { uniSlug: 'iub', season: 'Spring', year: 2026, slot: 1, appDeadline: '2025-12-14T23:59:59+06:00', examDate: '2025-12-19', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'iub', season: 'Summer', year: 2026, slot: 1, appDeadline: '2026-02-28T23:59:59+06:00', examDate: '2026-03-06', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'iub', season: 'Autumn', year: 2026, slot: 1, appDeadline: '2026-08-23T23:59:59+06:00', examDate: '2026-08-28', time: '10:00 AM', status: 'completed' },
      { uniSlug: 'iub', season: 'Spring', year: 2027, slot: 1, appDeadline: '2026-12-12T23:59:59+06:00', examDate: '2026-12-18', time: '10:00 AM', status: 'upcoming' }
    ];

    for (const ac of admissionCycles) {
      const uniUuid = uniIdMap[ac.uniSlug];
      await client.query(`
        INSERT INTO public.admission_cycles (
          university_id, season, academic_year, slot_number, application_deadline,
          exam_date, exam_time, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
      `, [uniUuid, ac.season, ac.year, ac.slot, ac.appDeadline, ac.examDate, ac.time, ac.status]);
    }
    console.log(`[Seed Universities] Seeded ${admissionCycles.length} admission cycles with UUID foreign keys.`);

    await client.query('COMMIT');
    console.log('[Seed Universities] Transaction committed.');

    // 8. Run Verification Query
    const uniCheck = await client.query('SELECT count(*) FROM public.universities');
    const unitCheck = await client.query('SELECT count(*) FROM public.academic_units');
    const progCheck = await client.query('SELECT count(*) FROM public.programs');
    const feeCheck = await client.query('SELECT count(*) FROM public.program_fee_structures');
    const patCheck = await client.query('SELECT count(*) FROM public.admission_test_patterns');
    const cycCheck = await client.query('SELECT count(*) FROM public.admission_cycles');
    const ppmCheck = await client.query('SELECT count(*) FROM public.program_pattern_mappings');

    console.log('\n--- VERIFICATION STATS (UUID RELATIONS) ---');
    console.log(`Universities:             ${uniCheck.rows[0].count}`);
    console.log(`Academic Units:           ${unitCheck.rows[0].count}`);
    console.log(`Programs:                 ${progCheck.rows[0].count}`);
    console.log(`Fee Structures:           ${feeCheck.rows[0].count}`);
    console.log(`Test Patterns:            ${patCheck.rows[0].count}`);
    console.log(`Program-Pattern Mappings: ${ppmCheck.rows[0].count}`);
    console.log(`Admission Cycles:         ${cycCheck.rows[0].count}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Seed Universities] Error during seeding:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

seed();
