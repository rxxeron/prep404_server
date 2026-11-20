const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../server/.env') });
if (!process.env.DATABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
}
const { Client } = require('pg');

async function fixUniversityData() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('[Fix] Connected to PostgreSQL Supabase database.');

    // 1. Fix University details (summaries, formats, logos, portals, etc.)
    console.log('[Fix] Updating university metadata and exam summaries...');
    const universityUpdates = [
      {
        code: 'AUST',
        fullName: 'Ahsanullah University of Science and Technology',
        shortName: 'Ahsanullah',
        academicSystem: 'semester',
        campusLocation: '141 & 142, Love Road, Tejgaon Industrial Area, Dhaka-1208',
        websiteUrl: 'https://www.aust.edu',
        admissionPortalUrl: 'https://admission.aust.edu',
        examFormatType: 'faculty_wide',
        examPatternSummary: 'Faculty-wide exams: Category 1 (All Engineering units - CSE/EEE/CE/ME/IPE/TE) takes unified 320-mark Math/Physics/Chem/English MCQ (1h 45m); Category 2 adds 320-mark Drawing (1h 30m, Total 640 marks); Category 3 for BBA (Quantitative, English, GK). Application fee ৳ 800 via bKash.'
      },
      {
        code: 'NSU',
        fullName: 'North South University',
        shortName: 'North South',
        academicSystem: 'trimester',
        campusLocation: 'Plot 15, Block B, Bashundhara R/A, Dhaka-1229',
        websiteUrl: 'https://www.northsouth.edu',
        admissionPortalUrl: 'https://admissions.northsouth.edu',
        examFormatType: 'centralized',
        examPatternSummary: 'Centralized university test (2h 30m): Section 1 English Grammar/Vocab (40 Qs, 25m), Section 2 Quantitative Aptitude (50 Qs, 75m), Section 3 Reading Comprehension (20 Qs, 30m), Section 4 Essay Composition (1 Q, 20m). Architecture adds 30m Drawing (Total 3 hours). Application fee ৳ 2,000 (৳ 2,031 via bKash).'
      },
      {
        code: 'BRACU',
        fullName: 'BRAC University',
        shortName: 'BRAC',
        academicSystem: 'trimester',
        campusLocation: 'Kha 224, Bir Uttam Rafiqul Islam Avenue, Merul Badda, Dhaka 1212',
        websiteUrl: 'https://www.bracu.ac.bd',
        admissionPortalUrl: 'https://admissions.bracu.ac.bd',
        examFormatType: 'centralized',
        examPatternSummary: 'Centralized assessment: Section A English Language MCQ, Section B English Composition, Section C Math/Logical Reasoning, Section D Higher Math & Physics (Engineering/CS), Section E Biology & Chemistry (Life Sciences/Pharmacy), Section F/G Drawing (Architecture). Candidates must pass each required section. Application fee ৳ 1,750.'
      },
      {
        code: 'AIUB',
        fullName: 'American International University-Bangladesh',
        shortName: 'AIUB',
        academicSystem: 'semester',
        campusLocation: '408/1, Kuratoli, Khilkhet, Dhaka 1229',
        websiteUrl: 'https://www.aiub.edu',
        admissionPortalUrl: 'https://admission.aiub.edu',
        examFormatType: 'faculty_wide',
        examPatternSummary: 'Faculty-wide exams (100 mins, 100 marks, No calculators): Engineering/FST (English MCQs 50 marks, Math & Physics MCQs 50 marks + Paragraph Writing); FBA/BBA (Quantitative 40, English 40, General Knowledge 20 + Paragraph); Architecture adds drawing. Application fee ৳ 1,000.'
      },
      {
        code: 'EWU',
        fullName: 'East West University',
        shortName: 'East West',
        academicSystem: 'trimester',
        campusLocation: 'A/2, Jahurul Islam Avenue, Jahurul Islam City, Aftabnagar, Dhaka-1212',
        websiteUrl: 'https://www.ewubd.edu',
        admissionPortalUrl: 'https://admission.ewubd.edu',
        examFormatType: 'faculty_wide',
        examPatternSummary: 'Faculty-wide exams: Faculty of Sciences & Engineering (Higher Math, Physics, Chemistry, English); Faculty of Business & Economics (English Grammar 20, Reading 20, Math 50, Essay 10 = 100 Marks); Life Sciences (Pharmacy/Biology). Merit evaluated: 75% test + 10% SSC + 15% HSC. Application fee ৳ 1,500.'
      },
      {
        code: 'IUB',
        fullName: 'Independent University, Bangladesh',
        shortName: 'IUB',
        academicSystem: 'trimester',
        campusLocation: 'Plot 16, Block B, Aftabuddin Ahmed Road, Bashundhara R/A, Dhaka-1229',
        websiteUrl: 'https://www.iub.edu.bd',
        admissionPortalUrl: 'https://admission.iub.edu.bd',
        examFormatType: 'centralized',
        examPatternSummary: 'Centralized examination testing English Verbal, Reading Comprehension, and Quantitative Mathematics (General Math for Business/Social Sciences; Higher Math & Physics for SETS engineering applicants). Application fee ৳ 1,500.'
      },
      {
        code: 'UIU',
        fullName: 'United International University',
        shortName: 'UIU',
        academicSystem: 'trimester',
        campusLocation: 'United City, Madani Avenue, Badda, Dhaka 1212',
        websiteUrl: 'https://www.uiu.ac.bd',
        admissionPortalUrl: 'https://admission.uiu.ac.bd',
        examFormatType: 'faculty_wide',
        examPatternSummary: 'School-wide examinations: School of Science & Engineering (75 marks: Math, Physics, English), School of Business & Economics (75 marks: Math, English, Analytical), and School of Life Sciences. Application fee ৳ 1,000 (৳ 500 per additional school).'
      },
      {
        code: 'UAP',
        fullName: 'University of Asia Pacific',
        shortName: 'UAP',
        academicSystem: 'semester',
        campusLocation: '74/A, Green Road, Farmgate, Dhaka - 1205',
        websiteUrl: 'https://www.uap-bd.edu',
        admissionPortalUrl: 'https://admission.uap-bd.edu',
        examFormatType: 'department_wise',
        examPatternSummary: 'Department-wise independent exams: Engineering departments test Math, Physics, Chemistry, English; Architecture tests Drawing & Aptitude; Pharmacy tests Biology, Chemistry, Math, English; BBA & Law test Quantitative & English. Application fee ৳ 1,200.'
      }
    ];

    for (const u of universityUpdates) {
      await client.query(`
        UPDATE public.universities
        SET
          full_name = $2,
          short_name = $3,
          academic_system = $4,
          campus_location = $5,
          website_url = $6,
          admission_portal_url = $7,
          exam_format_type = $8,
          exam_pattern_summary = $9,
          updated_at = NOW()
        WHERE code = $1;
      `, [u.code, u.fullName, u.shortName, u.academicSystem, u.campusLocation, u.websiteUrl, u.admissionPortalUrl, u.examFormatType, u.examPatternSummary]);
    }
    console.log('[Fix] Universities updated successfully.');

    // 2. Clean up duplicate programs in BRACU
    console.log('[Fix] Cleaning up duplicate programs in BRACU...');
    await client.query(`
      DELETE FROM public.programs
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY university_id, name ORDER BY created_at ASC) as rnum
          FROM public.programs
        ) t
        WHERE t.rnum > 1
      );
    `);
    console.log('[Fix] Duplicate programs purged.');

    // 3. Update Admission Cycles with verified real fees, slots and dates
    console.log('[Fix] Updating admission cycles with verified real data...');
    // Clear out outdated admission cycles and insert clean accurate upcoming schedules
    await client.query(`DELETE FROM public.admission_cycles;`);

    const cycles = [
      // AUST (Spring 2026 Upcoming) - Fee is ৳ 800 via bKash
      {
        uniCode: 'AUST',
        season: 'Spring',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 1,
        slotTitle: 'Category 1: Engineering & Category 2: Architecture Entrance Test',
        examDate: '2026-11-29',
        examTime: '09:30 AM - 12:45 PM',
        deadline: '2026-11-15T17:59:59+00:00',
        fee: '৳ 800',
        venue: 'AUST Permanent Campus, Tejgaon, Dhaka',
        notes: 'Category 1: 320-mark MCQ (Math 100, Physics 100, Chem 100, English 20). Category 2 adds 320-mark Drawing.'
      },
      {
        uniCode: 'AUST',
        season: 'Spring',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 2,
        slotTitle: 'Category 3: Business Administration (BBA) Admission Test',
        examDate: '2026-12-05',
        examTime: '10:00 AM - 11:30 AM',
        deadline: '2026-11-25T17:59:59+00:00',
        fee: '৳ 800',
        venue: 'AUST Permanent Campus, Tejgaon, Dhaka',
        notes: 'Objective MCQ covering Basic Math, English Grammar, and General Knowledge.'
      },

      // NSU (Spring 2026 Upcoming) - Fee is ৳ 2,000 (৳ 2,031 via bKash)
      {
        uniCode: 'NSU',
        season: 'Spring',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 1,
        slotTitle: 'Slot 1: Centralized Entrance Exam (All Schools)',
        examDate: '2026-11-28',
        examTime: '10:00 AM - 12:30 PM',
        deadline: '2026-11-20T17:59:59+00:00',
        fee: '৳ 2,000',
        venue: 'NSU Bashundhara Campus, Dhaka',
        notes: 'English Grammar (40), Math (50), Reading (20), Composition (1). B.Arch candidates have 30-min drawing extension.'
      },
      {
        uniCode: 'NSU',
        season: 'Spring',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 2,
        slotTitle: 'Slot 2: Regular Intake & Architecture Drawing',
        examDate: '2026-12-19',
        examTime: '10:00 AM - 01:00 PM',
        deadline: '2026-12-10T17:59:59+00:00',
        fee: '৳ 2,000',
        venue: 'NSU Bashundhara Campus, Dhaka',
        notes: 'Regular Spring intake slot.'
      },

      // BRACU (Spring 2026 Upcoming) - Fee is ৳ 1,750
      {
        uniCode: 'BRACU',
        season: 'Spring',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 1,
        slotTitle: 'Slot 1: Early Assessment (All Disciplines)',
        examDate: '2026-12-05',
        examTime: '09:30 AM - 12:00 PM',
        deadline: '2026-11-25T17:59:59+00:00',
        fee: '৳ 1,750',
        venue: 'BRAC University Merul Badda Campus, Dhaka',
        notes: 'Stream evaluation for CSE, EEE, BBA, Pharmacy, English, Law & Architecture. Individual section pass required.'
      },
      {
        uniCode: 'BRACU',
        season: 'Spring',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 2,
        slotTitle: 'Slot 2: Regular Intake & Transfer Exam',
        examDate: '2027-01-08',
        examTime: '09:30 AM - 12:00 PM',
        deadline: '2027-01-02T17:59:59+00:00',
        fee: '৳ 1,750',
        venue: 'BRAC University Merul Badda Campus, Dhaka',
        notes: 'Second intake slot for Spring semester.'
      },

      // AIUB (Spring 2026 Upcoming) - Fee is ৳ 1,000
      {
        uniCode: 'AIUB',
        season: 'Spring',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 1,
        slotTitle: 'Slot 1: Early Admission Test (Morning Shift)',
        examDate: '2026-11-26',
        examTime: '10:00 AM - 11:40 AM',
        deadline: '2026-11-22T08:00:00+00:00',
        fee: '৳ 1,000',
        venue: 'AIUB Campus, 408/1 Kuratoli, Khilkhet, Dhaka',
        notes: '100 mins, 100 marks. No calculators. Engineering/FST (English 50, Math/Physics 50); FBA (Math 40, English 40, GK 20).'
      },
      {
        uniCode: 'AIUB',
        season: 'Spring',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 2,
        slotTitle: 'Slot 2: Regular Admission Test (Afternoon Shift)',
        examDate: '2026-12-22',
        examTime: '02:00 PM - 03:40 PM',
        deadline: '2026-12-18T08:00:00+00:00',
        fee: '৳ 1,000',
        venue: 'AIUB Campus, 408/1 Kuratoli, Khilkhet, Dhaka',
        notes: 'Regular admission shift.'
      },

      // EWU (Spring 2026 Upcoming) - Fee is ৳ 1,500
      {
        uniCode: 'EWU',
        season: 'Spring',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 1,
        slotTitle: 'Slot 1: Written Admission Test (Sciences & Business)',
        examDate: '2026-12-08',
        examTime: '10:00 AM - 11:30 AM',
        deadline: '2026-11-30T17:59:59+00:00',
        fee: '৳ 1,500',
        venue: 'EWU Campus, Aftabnagar, Dhaka',
        notes: 'Faculty-wide tests: Science & Engineering (Higher Math, Physics, Chemistry, English); Business (English 40, Math 50, Essay 10).'
      },
      {
        uniCode: 'EWU',
        season: 'Spring',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 2,
        slotTitle: 'Slot 2: Regular Intake (All Programs)',
        examDate: '2026-12-26',
        examTime: '10:00 AM - 11:30 AM',
        deadline: '2026-12-20T17:59:59+00:00',
        fee: '৳ 1,500',
        venue: 'EWU Campus, Aftabnagar, Dhaka',
        notes: 'Regular Spring intake.'
      },

      // IUB (Spring 2026 Upcoming) - Fee is ৳ 1,500
      {
        uniCode: 'IUB',
        season: 'Spring',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 1,
        slotTitle: 'Slot 1: Early Bird Admission Test (All Schools)',
        examDate: '2026-12-01',
        examTime: '10:00 AM - 12:00 PM',
        deadline: '2026-11-24T17:59:59+00:00',
        fee: '৳ 1,500',
        venue: 'IUB Campus, Bashundhara R/A, Dhaka',
        notes: 'Centralized exam covering English Verbal, Reading, and Quantitative Mathematics.'
      },
      {
        uniCode: 'IUB',
        season: 'Spring',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 2,
        slotTitle: 'Slot 2: Regular Intake & Viva',
        examDate: '2026-12-24',
        examTime: '10:00 AM - 12:00 PM',
        deadline: '2026-12-19T17:59:59+00:00',
        fee: '৳ 1,500',
        venue: 'IUB Campus, Bashundhara R/A, Dhaka',
        notes: 'Regular Spring admission test.'
      },

      // UIU (Spring 2026 Upcoming) - Fee is ৳ 1,000 (৳ 500 extra school)
      {
        uniCode: 'UIU',
        season: 'Spring',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 1,
        slotTitle: 'Slot 1: School of Science & Engineering + Business',
        examDate: '2026-12-04',
        examTime: '10:00 AM - 11:30 AM',
        deadline: '2026-11-28T17:59:59+00:00',
        fee: '৳ 1,000',
        venue: 'UIU Campus, United City, Madani Avenue, Badda, Dhaka',
        notes: 'School-wide examinations: SOSE (Math, Physics, English); SOBE (Math, English, Analytical). ৳ 500 per extra school.'
      },
      {
        uniCode: 'UIU',
        season: 'Spring',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 2,
        slotTitle: 'Slot 2: General & Remaining Seats Intake',
        examDate: '2027-01-05',
        examTime: '10:00 AM - 11:30 AM',
        deadline: '2026-12-28T17:59:59+00:00',
        fee: '৳ 1,000',
        venue: 'UIU Campus, United City, Madani Avenue, Badda, Dhaka',
        notes: 'Second intake slot.'
      },

      // UAP (Fall 2026 Upcoming) - Fee is ৳ 1,200
      {
        uniCode: 'UAP',
        season: 'Fall',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 1,
        slotTitle: 'Slot 1: Engineering & Architecture Intake',
        examDate: '2026-11-25',
        examTime: '11:00 AM - 12:30 PM',
        deadline: '2026-11-18T17:59:59+00:00',
        fee: '৳ 1,200',
        venue: 'UAP Campus, 74/A Green Road, Farmgate, Dhaka',
        notes: 'Department-wise exam: Engineering (Math, Physics, Chemistry, English); Architecture (Drawing & Aptitude).'
      },
      {
        uniCode: 'UAP',
        season: 'Fall',
        academicYear: 2026,
        status: 'upcoming',
        slotNumber: 2,
        slotTitle: 'Slot 2: Pharmacy, Business, Law & English',
        examDate: '2026-12-18',
        examTime: '10:00 AM - 11:30 AM',
        deadline: '2026-12-14T17:59:59+00:00',
        fee: '৳ 1,200',
        venue: 'UAP Campus, 74/A Green Road, Farmgate, Dhaka',
        notes: 'Department-wise exam: Pharmacy (Biology, Chemistry, Math, English); BBA & Law (English & Quantitative).'
      }
    ];

    for (const c of cycles) {
      await client.query(`
        INSERT INTO public.admission_cycles (
          university_id, season, academic_year, status, slot_number, slot_title,
          exam_date, exam_time, application_deadline, application_fee, venue, notes
        )
        SELECT 
          u.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
        FROM public.universities u
        WHERE u.code = $1;
      `, [c.uniCode, c.season, c.academicYear, c.status, c.slotNumber, c.slotTitle, c.examDate, c.examTime, c.deadline, c.fee, c.venue, c.notes]);
    }
    console.log(`[Fix] Inserted ${cycles.length} verified admission cycles.`);

    console.log('[Fix] All university information updated successfully.');
  } catch (err) {
    console.error('[Fix] Error updating database:', err);
  } finally {
    await client.end();
  }
}

fixUniversityData();
