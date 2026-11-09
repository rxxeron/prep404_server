const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const client = await pool.connect();
  try {
    console.log('[Migration] Connected to Supabase DB.');
    await client.query('BEGIN');

    // 1. Add extra columns to admission_cycles if not present
    await client.query(`
      ALTER TABLE public.admission_cycles 
      ADD COLUMN IF NOT EXISTS slot_title VARCHAR(150),
      ADD COLUMN IF NOT EXISTS application_fee VARCHAR(50) DEFAULT '৳ 1,500',
      ADD COLUMN IF NOT EXISTS venue VARCHAR(200),
      ADD COLUMN IF NOT EXISTS notes TEXT;
    `);
    console.log('[Migration] admission_cycles columns updated.');

    // 2. Query Universities to map slug -> UUID
    const uniRes = await client.query(`SELECT id, slug, code FROM public.universities;`);
    const uniMap = {}; // slug -> id
    const uniCodeMap = {}; // code -> id
    uniRes.rows.forEach(u => {
      uniMap[u.slug] = u.id;
      uniCodeMap[u.code] = u.id;
    });

    // 3. Ensure Academic Units exist for IUB Law if missing
    if (uniMap['iub']) {
      await client.query(`
        INSERT INTO public.academic_units (university_id, slug, unit_type, name, short_code)
        VALUES ($1, 'sol', 'school', 'School of Law', 'SoL')
        ON CONFLICT (university_id, slug) DO NOTHING;
      `, [uniMap['iub']]);
    }

    // Map all academic units: `${uniSlug}:${unitSlug}` -> UUID
    const unitRes = await client.query(`
      SELECT au.id, u.slug as uni_slug, au.slug as unit_slug 
      FROM public.academic_units au
      JOIN public.universities u ON u.id = au.university_id;
    `);
    const unitMap = {};
    unitRes.rows.forEach(r => {
      unitMap[`${r.uni_slug}:${r.unit_slug}`] = r.id;
    });

    // 4. Comprehensive Official Undergraduate Programs for all 8 Universities
    const fullPrograms = [
      // ================= NSU =================
      { uni: 'nsu', unit: 'sbe', slug: 'bba', name: 'Bachelor of Business Administration (BBA)', cat: 'business', credits: 130, dur: 4.0 },
      { uni: 'nsu', unit: 'sbe', slug: 'econ', name: 'B.S. in Economics', cat: 'business', credits: 120, dur: 4.0 },
      { uni: 'nsu', unit: 'seps', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)', cat: 'engineering', credits: 148, dur: 4.0 },
      { uni: 'nsu', unit: 'seps', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)', cat: 'engineering', credits: 144, dur: 4.0 },
      { uni: 'nsu', unit: 'seps', slug: 'cee', name: 'B.Sc. in Civil & Environmental Engineering (CEE)', cat: 'engineering', credits: 149, dur: 4.0 },
      { uni: 'nsu', unit: 'seps', slug: 'arch', name: 'Bachelor of Architecture (B.Arch)', cat: 'architecture', credits: 177, dur: 5.0 },
      { uni: 'nsu', unit: 'shls', slug: 'pharm', name: 'Bachelor of Pharmacy Professional (B.Pharm)', cat: 'pharmacy', credits: 160, dur: 4.0 },
      { uni: 'nsu', unit: 'shls', slug: 'biochem', name: 'B.Sc. in Biochemistry and Biotechnology', cat: 'sciences', credits: 130, dur: 4.0 },
      { uni: 'nsu', unit: 'shls', slug: 'microbio', name: 'B.Sc. in Microbiology', cat: 'sciences', credits: 130, dur: 4.0 },
      { uni: 'nsu', unit: 'shls', slug: 'env_mgmt', name: 'B.Sc. in Environmental Science & Management', cat: 'sciences', credits: 130, dur: 4.0 },
      { uni: 'nsu', unit: 'shss', slug: 'llb', name: 'Bachelor of Laws (LL.B. Hons)', cat: 'law', credits: 130, dur: 4.0 },
      { uni: 'nsu', unit: 'shss', slug: 'eng', name: 'B.A. in English (Literature & TESOL)', cat: 'humanities', credits: 120, dur: 4.0 },
      { uni: 'nsu', unit: 'shss', slug: 'mcj', name: 'B.S.S. in Media, Communication & Journalism (MCJ)', cat: 'humanities', credits: 123, dur: 4.0 },

      // ================= BRACU =================
      { uni: 'brac', unit: 'bbs', slug: 'bba', name: 'Bachelor of Business Administration (BBA)', cat: 'business', credits: 130, dur: 4.0 },
      { uni: 'brac', unit: 'sds', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)', cat: 'engineering', credits: 144, dur: 4.0 },
      { uni: 'brac', unit: 'sds', slug: 'cs', name: 'B.Sc. in Computer Science (CS)', cat: 'engineering', credits: 136, dur: 4.0 },
      { uni: 'brac', unit: 'sds', slug: 'math', name: 'B.Sc. in Mathematics', cat: 'sciences', credits: 127, dur: 4.0 },
      { uni: 'brac', unit: 'sds', slug: 'phy', name: 'B.Sc. in Physics', cat: 'sciences', credits: 128, dur: 4.0 },
      { uni: 'brac', unit: 'sds', slug: 'biotech', name: 'B.Sc. in Biotechnology', cat: 'sciences', credits: 136, dur: 4.0 },
      { uni: 'brac', unit: 'sds', slug: 'microbio', name: 'B.Sc. in Microbiology', cat: 'sciences', credits: 136, dur: 4.0 },
      { uni: 'brac', unit: 'soe', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)', cat: 'engineering', credits: 144, dur: 4.0 },
      { uni: 'brac', unit: 'soe', slug: 'ece', name: 'B.Sc. in Electronic and Communication Engineering (ECE)', cat: 'engineering', credits: 144, dur: 4.0 },
      { uni: 'brac', unit: 'arch', slug: 'arch', name: 'Bachelor of Architecture (B.Arch)', cat: 'architecture', credits: 177, dur: 5.0 },
      { uni: 'brac', unit: 'shss', slug: 'econ', name: 'B.S.S. in Economics', cat: 'business', credits: 120, dur: 4.0 },
      { uni: 'brac', unit: 'shss', slug: 'eng', name: 'B.A. in English', cat: 'humanities', credits: 120, dur: 4.0 },
      { uni: 'brac', unit: 'shss', slug: 'anthro', name: 'B.S.S. in Anthropology', cat: 'humanities', credits: 120, dur: 4.0 },
      { uni: 'brac', unit: 'sol', slug: 'llb', name: 'Bachelor of Laws (LL.B. Hons)', cat: 'law', credits: 135, dur: 4.0 },
      { uni: 'brac', unit: 'sphr', slug: 'pharm', name: 'Bachelor of Pharmacy (B.Pharm Hons)', cat: 'pharmacy', credits: 164, dur: 4.0 },

      // ================= EWU =================
      { uni: 'ewu', unit: 'fbe', slug: 'bba', name: 'Bachelor of Business Administration (BBA)', cat: 'business', credits: 130, dur: 4.0 },
      { uni: 'ewu', unit: 'fbe', slug: 'econ', name: 'B.S.S. in Economics', cat: 'business', credits: 120, dur: 4.0 },
      { uni: 'ewu', unit: 'fse', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)', cat: 'engineering', credits: 140, dur: 4.0 },
      { uni: 'ewu', unit: 'fse', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)', cat: 'engineering', credits: 140, dur: 4.0 },
      { uni: 'ewu', unit: 'fse', slug: 'ce', name: 'B.Sc. in Civil Engineering (CE)', cat: 'engineering', credits: 151, dur: 4.0 },
      { uni: 'ewu', unit: 'fse', slug: 'ice', name: 'B.Sc. in Information & Communication Engineering', cat: 'engineering', credits: 140, dur: 4.0 },
      { uni: 'ewu', unit: 'fse', slug: 'pharm', name: 'Bachelor of Pharmacy (B.Pharm)', cat: 'pharmacy', credits: 158, dur: 4.0 },
      { uni: 'ewu', unit: 'fse', slug: 'geb', name: 'B.Sc. in Genetic Engineering & Biotechnology', cat: 'sciences', credits: 130, dur: 4.0 },
      { uni: 'ewu', unit: 'flass', slug: 'llb', name: 'Bachelor of Laws (LL.B. Hons)', cat: 'law', credits: 130, dur: 4.0 },
      { uni: 'ewu', unit: 'flass', slug: 'eng', name: 'B.A. in English', cat: 'humanities', credits: 123, dur: 4.0 },
      { uni: 'ewu', unit: 'flass', slug: 'soc', name: 'B.S.S. in Sociology', cat: 'humanities', credits: 123, dur: 4.0 },
      { uni: 'ewu', unit: 'flass', slug: 'is', name: 'B.S.S. in Information Studies', cat: 'humanities', credits: 123, dur: 4.0 },

      // ================= AUST =================
      { uni: 'aust', unit: 'fet', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)', cat: 'engineering', credits: 160, dur: 4.0 },
      { uni: 'aust', unit: 'fet', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)', cat: 'engineering', credits: 160, dur: 4.0 },
      { uni: 'aust', unit: 'fet', slug: 'ce', name: 'B.Sc. in Civil Engineering (CE)', cat: 'engineering', credits: 160, dur: 4.0 },
      { uni: 'aust', unit: 'fet', slug: 'me', name: 'B.Sc. in Mechanical Engineering (ME)', cat: 'engineering', credits: 160, dur: 4.0 },
      { uni: 'aust', unit: 'fet', slug: 'ipe', name: 'B.Sc. in Industrial & Production Engineering (IPE)', cat: 'engineering', credits: 160, dur: 4.0 },
      { uni: 'aust', unit: 'fet', slug: 'te', name: 'B.Sc. in Textile Engineering (TE)', cat: 'engineering', credits: 160, dur: 4.0 },
      { uni: 'aust', unit: 'fap', slug: 'arch', name: 'Bachelor of Architecture (B.Arch)', cat: 'architecture', credits: 195, dur: 5.0 },
      { uni: 'aust', unit: 'fbss', slug: 'bba', name: 'Bachelor of Business Administration (BBA)', cat: 'business', credits: 132, dur: 4.0 },

      // ================= AIUB =================
      { uni: 'aiub', unit: 'fst', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)', cat: 'engineering', credits: 148, dur: 4.0 },
      { uni: 'aiub', unit: 'fst', slug: 'csse', name: 'B.Sc. in Computer Science & Software Engineering (CSSE)', cat: 'engineering', credits: 148, dur: 4.0 },
      { uni: 'aiub', unit: 'fst', slug: 'cis', name: 'B.Sc. in Computer Information Systems (CIS)', cat: 'engineering', credits: 130, dur: 4.0 },
      { uni: 'aiub', unit: 'fe', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)', cat: 'engineering', credits: 144, dur: 4.0 },
      { uni: 'aiub', unit: 'fe', slug: 'coe', name: 'B.Sc. in Computer Engineering (CoE)', cat: 'engineering', credits: 144, dur: 4.0 },
      { uni: 'aiub', unit: 'fe', slug: 'ipe', name: 'B.Sc. in Industrial & Production Engineering (IPE)', cat: 'engineering', credits: 144, dur: 4.0 },
      { uni: 'aiub', unit: 'fe', slug: 'arch', name: 'Bachelor of Architecture (B.Arch)', cat: 'architecture', credits: 180, dur: 5.0 },
      { uni: 'aiub', unit: 'fba', slug: 'bba', name: 'Bachelor of Business Administration (BBA)', cat: 'business', credits: 130, dur: 4.0 },
      { uni: 'aiub', unit: 'fba', slug: 'econ', name: 'B.S.S. in Economics', cat: 'business', credits: 120, dur: 4.0 },
      { uni: 'aiub', unit: 'fhls', slug: 'pharm', name: 'Bachelor of Pharmacy (B.Pharm)', cat: 'pharmacy', credits: 160, dur: 4.0 },
      { uni: 'aiub', unit: 'fass', slug: 'llb', name: 'Bachelor of Laws (LL.B.)', cat: 'law', credits: 130, dur: 4.0 },
      { uni: 'aiub', unit: 'fass', slug: 'eng', name: 'B.A. in English', cat: 'humanities', credits: 120, dur: 4.0 },
      { uni: 'aiub', unit: 'fass', slug: 'mmc', name: 'B.S.S. in Media & Mass Communication (MMC)', cat: 'humanities', credits: 120, dur: 4.0 },

      // ================= UIU =================
      { uni: 'uiu', unit: 'sose', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)', cat: 'engineering', credits: 141, dur: 4.0 },
      { uni: 'uiu', unit: 'sose', slug: 'ds', name: 'B.Sc. in Data Science (DS)', cat: 'engineering', credits: 140, dur: 4.0 },
      { uni: 'uiu', unit: 'sose', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)', cat: 'engineering', credits: 140, dur: 4.0 },
      { uni: 'uiu', unit: 'sose', slug: 'ce', name: 'B.Sc. in Civil Engineering (CE)', cat: 'engineering', credits: 150, dur: 4.0 },
      { uni: 'uiu', unit: 'sobe', slug: 'bba', name: 'Bachelor of Business Administration (BBA)', cat: 'business', credits: 126, dur: 4.0 },
      { uni: 'uiu', unit: 'sobe', slug: 'econ', name: 'B.S. in Economics', cat: 'business', credits: 120, dur: 4.0 },
      { uni: 'uiu', unit: 'slhs', slug: 'pharm', name: 'Bachelor of Pharmacy (B.Pharm)', cat: 'pharmacy', credits: 160, dur: 4.0 },
      { uni: 'uiu', unit: 'slhs', slug: 'bge', name: 'B.Sc. in Biotechnology & Genetic Engineering', cat: 'sciences', credits: 130, dur: 4.0 },
      { uni: 'uiu', unit: 'shss', slug: 'msj', name: 'B.S.S. in Media Studies & Journalism (MSJ)', cat: 'humanities', credits: 123, dur: 4.0 },
      { uni: 'uiu', unit: 'shss', slug: 'eds', name: 'B.S.S. in Environment & Development Studies', cat: 'humanities', credits: 123, dur: 4.0 },

      // ================= UAP =================
      { uni: 'uap', unit: 'eng', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)', cat: 'engineering', credits: 155, dur: 4.0 },
      { uni: 'uap', unit: 'eng', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)', cat: 'engineering', credits: 155, dur: 4.0 },
      { uni: 'uap', unit: 'eng', slug: 'ce', name: 'B.Sc. in Civil Engineering (CE)', cat: 'engineering', credits: 160, dur: 4.0 },
      { uni: 'uap', unit: 'arch', slug: 'arch', name: 'Bachelor of Architecture (B.Arch)', cat: 'architecture', credits: 195, dur: 5.0 },
      { uni: 'uap', unit: 'bus', slug: 'bba', name: 'Bachelor of Business Administration (BBA)', cat: 'business', credits: 130, dur: 4.0 },
      { uni: 'uap', unit: 'med', slug: 'pharm', name: 'Bachelor of Pharmacy (B.Pharm Hons)', cat: 'pharmacy', credits: 160, dur: 4.0 },
      { uni: 'uap', unit: 'hss', slug: 'llb', name: 'Bachelor of Laws (LL.B. Hons)', cat: 'law', credits: 135, dur: 4.0 },
      { uni: 'uap', unit: 'hss', slug: 'eng', name: 'B.A. in English', cat: 'humanities', credits: 120, dur: 4.0 },

      // ================= IUB =================
      { uni: 'iub', unit: 'sets', slug: 'cse', name: 'B.Sc. in Computer Science & Engineering (CSE)', cat: 'engineering', credits: 140, dur: 4.0 },
      { uni: 'iub', unit: 'sets', slug: 'cs', name: 'B.Sc. in Computer Science (CS)', cat: 'engineering', credits: 130, dur: 4.0 },
      { uni: 'iub', unit: 'sets', slug: 'eee', name: 'B.Sc. in Electrical & Electronic Engineering (EEE)', cat: 'engineering', credits: 140, dur: 4.0 },
      { uni: 'iub', unit: 'sets', slug: 'ete', name: 'B.Sc. in Electronic & Telecommunication Engineering (ETE)', cat: 'engineering', credits: 140, dur: 4.0 },
      { uni: 'iub', unit: 'sbe', slug: 'bba', name: 'Bachelor of Business Administration (BBA)', cat: 'business', credits: 124, dur: 4.0 },
      { uni: 'iub', unit: 'sbe', slug: 'econ', name: 'B.Sc. in Economics', cat: 'business', credits: 120, dur: 4.0 },
      { uni: 'iub', unit: 'sels', slug: 'biochem', name: 'B.Sc. in Biochemistry & Biotechnology', cat: 'sciences', credits: 130, dur: 4.0 },
      { uni: 'iub', unit: 'sels', slug: 'microbio', name: 'B.Sc. in Microbiology', cat: 'sciences', credits: 130, dur: 4.0 },
      { uni: 'iub', unit: 'sels', slug: 'esm', name: 'B.Sc. in Environmental Science & Management', cat: 'sciences', credits: 120, dur: 4.0 },
      { uni: 'iub', unit: 'spph', slug: 'pharm', name: 'Bachelor of Pharmacy Professional (B.Pharm)', cat: 'pharmacy', credits: 160, dur: 4.0 },
      { uni: 'iub', unit: 'slass', slug: 'eng', name: 'B.A. in English', cat: 'humanities', credits: 120, dur: 4.0 },
      { uni: 'iub', unit: 'slass', slug: 'mc', name: 'B.S.S. in Media & Communication', cat: 'humanities', credits: 120, dur: 4.0 },
      { uni: 'iub', unit: 'slass', slug: 'gsg', name: 'B.S.S. in Global Studies & Governance', cat: 'humanities', credits: 120, dur: 4.0 },
      { uni: 'iub', unit: 'sol', slug: 'llb', name: 'Bachelor of Laws (LL.B. Hons)', cat: 'law', credits: 130, dur: 4.0 }
    ];

    let insertedProgs = 0;
    for (const p of fullPrograms) {
      const uId = uniMap[p.uni];
      const auId = unitMap[`${p.uni}:${p.unit}`];
      if (!uId || !auId) {
        console.warn(`Missing unit mapping for ${p.uni}:${p.unit}`);
        continue;
      }

      await client.query(`
        INSERT INTO public.programs (university_id, academic_unit_id, slug, name, degree_type, track_category, total_credits, duration_years, is_active)
        VALUES ($1, $2, $3, $4, 'bachelor', $5, $6, $7, true)
        ON CONFLICT (university_id, slug) 
        DO UPDATE SET 
          name = EXCLUDED.name,
          academic_unit_id = EXCLUDED.academic_unit_id,
          track_category = EXCLUDED.track_category,
          total_credits = EXCLUDED.total_credits,
          duration_years = EXCLUDED.duration_years,
          is_active = true;
      `, [uId, auId, p.slug, p.name, p.cat, p.credits, p.dur]);
      insertedProgs++;
    }
    console.log(`[Migration] Successfully upserted ${insertedProgs} official undergraduate programs.`);

    // 5. Populate / Refresh Upcoming Admission Cycles and Slots for all 8 Universities
    // We clean previous upcoming cycles to replace with verified, current multi-slot schedule
    await client.query(`DELETE FROM public.admission_cycles WHERE status = 'upcoming';`);

    const upcomingAdmissionCycles = [
      // NSU - Spring 2026 / 2027
      {
        uniSlug: 'nsu', season: 'Spring', year: 2026, slot: 1,
        slotTitle: 'Slot 1 (Physical Sciences, Engineering & Business)',
        appDeadline: '2026-11-20T23:59:59+06:00',
        examDate: '2026-11-28', examTime: '10:00 AM - 12:30 PM',
        fee: '৳ 1,500', venue: 'NSU Main Campus, Bashundhara R/A, Dhaka',
        notes: 'Calculator permitted for Engineering & Science disciplines only.'
      },
      {
        uniSlug: 'nsu', season: 'Spring', year: 2026, slot: 2,
        slotTitle: 'Slot 2 (Bio-Sciences, Architecture, Law & Arts)',
        appDeadline: '2026-12-10T23:59:59+06:00',
        examDate: '2026-12-19', examTime: '02:30 PM - 05:00 PM',
        fee: '৳ 1,500', venue: 'NSU Main Campus, Bashundhara R/A, Dhaka',
        notes: 'Drawing kit required for B.Arch candidates.'
      },

      // BRACU - Spring 2026
      {
        uniSlug: 'brac', season: 'Spring', year: 2026, slot: 1,
        slotTitle: 'Slot 1: Early Assessment (All Disciplines)',
        appDeadline: '2026-11-25T23:59:59+06:00',
        examDate: '2026-12-05', examTime: '09:30 AM - 12:00 PM',
        fee: '৳ 1,500', venue: 'BRAC University Merul Badda New Campus, Dhaka',
        notes: 'Strict physical reporting at 08:45 AM.'
      },
      {
        uniSlug: 'brac', season: 'Spring', year: 2026, slot: 2,
        slotTitle: 'Slot 2: Regular Intake & Transfer Exam',
        appDeadline: '2027-01-02T23:59:59+06:00',
        examDate: '2027-01-08', examTime: '09:30 AM - 12:00 PM',
        fee: '৳ 1,500', venue: 'BRAC University Merul Badda New Campus, Dhaka',
        notes: 'Online verification required before admit card print.'
      },

      // EWU - Spring 2026
      {
        uniSlug: 'ewu', season: 'Spring', year: 2026, slot: 1,
        slotTitle: 'Slot 1: Written Admission Test (Science & Business)',
        appDeadline: '2026-11-30T23:59:59+06:00',
        examDate: '2026-12-08', examTime: '10:00 AM - 11:30 AM',
        fee: '৳ 1,200', venue: 'EWU Campus, Aftabnagar, Dhaka',
        notes: 'Reporting time 30 minutes prior to exam.'
      },
      {
        uniSlug: 'ewu', season: 'Spring', year: 2026, slot: 2,
        slotTitle: 'Slot 2: Regular Intake (All Programs)',
        appDeadline: '2026-12-20T23:59:59+06:00',
        examDate: '2026-12-26', examTime: '10:00 AM - 11:30 AM',
        fee: '৳ 1,200', venue: 'EWU Campus, Aftabnagar, Dhaka',
        notes: 'Merit scholarship assessment included.'
      },

      // AUST - Fall 2026
      {
        uniSlug: 'aust', season: 'Fall', year: 2026, slot: 1,
        slotTitle: 'Slot 1: Engineering & Architecture Entrance Exam',
        appDeadline: '2026-11-15T23:59:59+06:00',
        examDate: '2026-11-29', examTime: '09:30 AM - 12:00 PM',
        fee: '৳ 1,200', venue: 'AUST Permanent Campus, Tejgaon, Dhaka',
        notes: 'Freehand drawing component for Architecture students.'
      },
      {
        uniSlug: 'aust', season: 'Fall', year: 2026, slot: 2,
        slotTitle: 'Slot 2: Business & Remaining Seats',
        appDeadline: '2026-12-15T23:59:59+06:00',
        examDate: '2026-12-22', examTime: '10:00 AM - 11:30 AM',
        fee: '৳ 1,000', venue: 'AUST Permanent Campus, Tejgaon, Dhaka',
        notes: 'Objective MCQ format.'
      },

      // AIUB - Spring 2026
      {
        uniSlug: 'aiub', season: 'Spring', year: 2026, slot: 1,
        slotTitle: 'Slot 1: Early Admission Test (Morning Shift)',
        appDeadline: '2026-11-22T14:00:00+06:00',
        examDate: '2026-11-26', examTime: '10:00 AM - 11:40 AM',
        fee: '৳ 1,000', venue: 'AIUB Campus, Kuratoli, Khilkhet, Dhaka',
        notes: 'Computer-based and Paper-based hybrid testing.'
      },
      {
        uniSlug: 'aiub', season: 'Spring', year: 2026, slot: 2,
        slotTitle: 'Slot 2: Regular Admission Test (Afternoon Shift)',
        appDeadline: '2026-12-18T14:00:00+06:00',
        examDate: '2026-12-22', examTime: '02:00 PM - 03:40 PM',
        fee: '৳ 1,000', venue: 'AIUB Campus, Kuratoli, Khilkhet, Dhaka',
        notes: 'Admit card printout with 2 color photos mandatory.'
      },

      // UIU - Spring 2026
      {
        uniSlug: 'uiu', season: 'Spring', year: 2026, slot: 1,
        slotTitle: 'Slot 1: School of Science & Engineering + Business',
        appDeadline: '2026-11-28T23:59:59+06:00',
        examDate: '2026-12-04', examTime: '10:00 AM - 11:30 AM',
        fee: '৳ 1,000', venue: 'UIU Campus, United City, Madani Avenue, Dhaka',
        notes: 'Top 10% scorers receive 50% tuition waiver.'
      },
      {
        uniSlug: 'uiu', season: 'Spring', year: 2026, slot: 2,
        slotTitle: 'Slot 2: General & Remaining Seats Intake',
        appDeadline: '2026-12-28T23:59:59+06:00',
        examDate: '2027-01-05', examTime: '10:00 AM - 11:30 AM',
        fee: '৳ 1,000', venue: 'UIU Campus, United City, Madani Avenue, Dhaka',
        notes: 'Direct admission viva right after exam.'
      },

      // UAP - Fall 2026 / Spring 2026
      {
        uniSlug: 'uap', season: 'Fall', year: 2026, slot: 1,
        slotTitle: 'Slot 1: Engineering & Architecture Intake',
        appDeadline: '2026-11-18T23:59:59+06:00',
        examDate: '2026-11-25', examTime: '11:00 AM - 12:30 PM',
        fee: '৳ 1,200', venue: 'UAP Campus, 74/A Green Road, Farmgate, Dhaka',
        notes: 'Special waiver for GPA 5.0 holders.'
      },
      {
        uniSlug: 'uap', season: 'Fall', year: 2026, slot: 2,
        slotTitle: 'Slot 2: Pharmacy, Business, Law & English',
        appDeadline: '2026-12-14T23:59:59+06:00',
        examDate: '2026-12-18', examTime: '10:00 AM - 11:30 AM',
        fee: '৳ 1,200', venue: 'UAP Campus, 74/A Green Road, Farmgate, Dhaka',
        notes: 'B.Pharm candidates undergo chemistry & biology screening.'
      },

      // IUB - Spring 2026
      {
        uniSlug: 'iub', season: 'Spring', year: 2026, slot: 1,
        slotTitle: 'Slot 1: Early Bird Admission Test (All Schools)',
        appDeadline: '2026-11-24T23:59:59+06:00',
        examDate: '2026-12-01', examTime: '10:00 AM - 12:00 PM',
        fee: '৳ 1,000', venue: 'IUB Campus, Plot 16, Block B, Bashundhara R/A, Dhaka',
        notes: 'English and Math proficiency evaluation.'
      },
      {
        uniSlug: 'iub', season: 'Spring', year: 2026, slot: 2,
        slotTitle: 'Slot 2: Regular Intake & Viva',
        appDeadline: '2026-12-19T23:59:59+06:00',
        examDate: '2026-12-24', examTime: '10:00 AM - 12:00 PM',
        fee: '৳ 1,000', venue: 'IUB Campus, Plot 16, Block B, Bashundhara R/A, Dhaka',
        notes: 'Result published within 48 hours.'
      }
    ];

    for (const c of upcomingAdmissionCycles) {
      const uId = uniMap[c.uniSlug];
      await client.query(`
        INSERT INTO public.admission_cycles (
          university_id, season, academic_year, slot_number, slot_title,
          application_deadline, exam_date, exam_time, application_fee, venue, notes, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'upcoming')
        ON CONFLICT (university_id, season, academic_year, slot_number)
        DO UPDATE SET
          slot_title = EXCLUDED.slot_title,
          application_deadline = EXCLUDED.application_deadline,
          exam_date = EXCLUDED.exam_date,
          exam_time = EXCLUDED.exam_time,
          application_fee = EXCLUDED.application_fee,
          venue = EXCLUDED.venue,
          notes = EXCLUDED.notes,
          status = 'upcoming';
      `, [uId, c.season, c.year, c.slot, c.slotTitle, c.appDeadline, c.examDate, c.examTime, c.fee, c.venue, c.notes]);
    }
    console.log(`[Migration] Successfully seeded ${upcomingAdmissionCycles.length} multi-slot upcoming admission cycles.`);

    await client.query('COMMIT');
    console.log('[Migration] All changes successfully committed to database!');

    // Verification
    const countProgs = await client.query(`
      SELECT u.code, count(p.id) as count 
      FROM public.universities u 
      LEFT JOIN public.programs p ON p.university_id = u.id 
      GROUP BY u.code ORDER BY u.code;
    `);
    console.log('\n--- VERIFICATION: Programs Count per University ---');
    countProgs.rows.forEach(r => console.log(`  ${r.code}: ${r.count} undergraduate programs`));

    const countSlots = await client.query(`
      SELECT u.code, count(ac.id) as upcoming_slots
      FROM public.universities u
      JOIN public.admission_cycles ac ON ac.university_id = u.id
      WHERE ac.status = 'upcoming'
      GROUP BY u.code ORDER BY u.code;
    `);
    console.log('\n--- VERIFICATION: Upcoming Admission Slots per University ---');
    countSlots.rows.forEach(r => console.log(`  ${r.code}: ${r.upcoming_slots} upcoming admission slots`));

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Migration] Failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
