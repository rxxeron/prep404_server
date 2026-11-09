const { Pool } = require('pg');
require('dotenv').config({ path: '.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function buildAdmissionJourney(uniCode, requestedTrack, horizonDays) {
  // 1. Fetch University
  const uniRes = await pool.query(`
    SELECT id, code, full_name AS "fullName", short_name AS "shortName", logo_url AS "logoUrl",
           campus_location AS "campusLocation", exam_pattern_summary AS "examPatternSummary"
    FROM universities
    WHERE UPPER(code) = $1 OR UPPER(slug) = $1
    LIMIT 1;
  `, [uniCode.toUpperCase()]);

  if (uniRes.rows.length === 0) return null;
  const university = uniRes.rows[0];

  // 2. Fetch Programs & Available Tracks
  const progsRes = await pool.query(`
    SELECT id, name, slug, track_category AS "trackCategory", degree_type AS "degreeType"
    FROM programs
    WHERE university_id = $1 AND is_active = true
    ORDER BY track_category ASC, name ASC;
  `, [university.id]);

  const availableTracks = Array.from(new Set(progsRes.rows.map(p => p.trackCategory)));
  const activeTrack = availableTracks.includes(requestedTrack)
    ? requestedTrack
    : (availableTracks.includes('engineering') ? 'engineering' : availableTracks[0]);

  // 3. Fetch Cycles & Upcoming Exam Date
  const cyclesRes = await pool.query(`
    SELECT id, season, academic_year AS "academicYear", slot_number AS "slotNumber",
           slot_title AS "slotTitle", application_deadline AS "applicationDeadline",
           exam_date AS "examDate", exam_time AS "examTime", application_fee AS "applicationFee",
           venue, status
    FROM admission_cycles
    WHERE university_id = $1
    ORDER BY exam_date ASC;
  `, [university.id]);

  const now = new Date();
  const upcomingCycle = cyclesRes.rows.find(c => new Date(c.examDate) >= now && c.status === 'upcoming') ||
    cyclesRes.rows.find(c => new Date(c.examDate) >= now) ||
    cyclesRes.rows[cyclesRes.rows.length - 1];

  const examDate = upcomingCycle ? new Date(upcomingCycle.examDate) : new Date(now.getTime() + 35 * 86400000);
  const diffMs = examDate.getTime() - now.getTime();
  const daysRemaining = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

  let autoHorizon = 30;
  if (daysRemaining <= 12) autoHorizon = 10;
  else if (daysRemaining <= 20) autoHorizon = 15;
  else if (daysRemaining <= 45) autoHorizon = 30;
  else autoHorizon = 60;

  const effectiveHorizon = (horizonDays && horizonDays > 0) ? horizonDays : autoHorizon;

  // 4. Fetch Patterns & Blueprints from Database
  const patternsRes = await pool.query(`
    SELECT id, pattern_name AS "patternName", test_archetype AS "testArchetype",
           total_marks AS "totalMarks", duration_minutes AS "durationMinutes",
           has_negative_marking AS "hasNegativeMarking",
           negative_marking_penalty AS "negativeMarkingPenalty",
           sections
    FROM admission_test_patterns
    WHERE university_id = $1;
  `, [university.id]);

  let pattern = patternsRes.rows.find(p => {
    if (activeTrack === 'business') return p.testArchetype === 'bba-law' || p.patternName.toLowerCase().includes('business') || p.patternName.toLowerCase().includes('bba');
    if (activeTrack === 'engineering') return p.testArchetype === 'eng' || p.testArchetype === 'eng-arch' || p.patternName.toLowerCase().includes('eng');
    return false;
  }) || patternsRes.rows[0];

  const rawSections = pattern ? (pattern.sections || []) : [];
  let totalSectionMarks = 0;
  rawSections.forEach(s => totalSectionMarks += (s.marks || s.questions || 20));
  if (totalSectionMarks === 0) totalSectionMarks = 100;

  const colorPalette = ['#FF7A36', '#FFD166', '#BA467A', '#10B981', '#3B82F6'];
  const sections = rawSections.map((s, idx) => {
    const marks = s.marks || s.questions || 25;
    const weight = Math.round((marks / totalSectionMarks) * 100);
    return {
      name: s.name,
      marks: `${marks} Marks`,
      weight: weight,
      color: colorPalette[idx % colorPalette.length],
      topics: s.topics || []
    };
  });

  // 5. Fetch Exams and Snapshots from Database
  const examsRes = await pool.query(`
    SELECT 
      e.id,
      e.title,
      e.track,
      e.exam_type AS "examType",
      ROUND(e.duration_seconds / 60) AS "durationMinutes",
      e.total_marks AS "totalMarks",
      COALESCE(e.negative_mark_per_question, 0.25) AS "negativeMarking",
      (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS "totalQuestions"
    FROM exams e
    WHERE (e.target_university_id = $1::uuid OR UPPER(e.track) = $2 OR UPPER(e.track) = 'GENERAL') 
      AND e.is_active = true
    ORDER BY e.created_at ASC;
  `, [university.id, university.code.toUpperCase()]);

  const allExams = examsRes.rows;

  const isBusiness = activeTrack === 'business';
  const isPharm = activeTrack === 'pharmacy';
  const isArch = activeTrack === 'architecture';

  const relevantExams = allExams.filter(e => {
    const t = e.title.toLowerCase();
    if (isBusiness) {
      if (t.includes('physics') || t.includes('higher math') || t.includes('calculus')) return false;
      return true;
    }
    if (isPharm) {
      if (t.includes('higher math') || t.includes('calculus') || t.includes('mechanical')) return false;
      return true;
    }
    if (isArch) {
      if (t.includes('biology') || t.includes('chemistry')) return false;
      return true;
    }
    if (t.includes('biology') || t.includes('general knowledge') || (t.includes('business') && !t.includes('engineering'))) return false;
    return true;
  });

  const sectionExams = relevantExams.filter(e => e.examType === 'section_exam');
  const modelTests = relevantExams.filter(e => e.examType === 'model_test' || e.examType === 'daily_live');
  const pastPapers = relevantExams.filter(e => e.examType === 'uni_exam');

  const stage1Tests = [];
  const stage2Tests = [];
  const stage3Tests = [];
  const stage4Tests = [];

  // Stage 1: Speed drills
  for (let i = 0; i < Math.min(sectionExams.length, 5); i++) {
    const ex = sectionExams[i];
    stage1Tests.push({
      id: ex.id,
      slug: ex.id,
      title: ex.title,
      subtitle: `${ex.totalQuestions} Questions • Fast Speed Drill`,
      pillar: 'topicWise',
      dayNumber: i + 1,
      totalQuestions: parseInt(ex.totalQuestions, 10) || 25,
      durationMinutes: ex.durationMinutes || 25,
      totalMarks: parseFloat(ex.totalMarks) || 25,
      negativeMark: parseFloat(ex.negativeMarking) || 0.25,
      difficulty: 'High-Yield Drill'
    });
  }

  // Stage 2: Subject mastery
  for (let i = 0; i < Math.min(sectionExams.length, 4); i++) {
    const ex = sectionExams[sectionExams.length - 1 - i];
    if (ex && !stage1Tests.some(t => t.id === ex.id)) {
      stage2Tests.push({
        id: ex.id,
        slug: ex.id,
        title: ex.title,
        subtitle: `Comprehensive Subject Syllabus Integration`,
        pillar: 'subjectWise',
        dayNumber: Math.round(effectiveHorizon * 0.35) + i * 2,
        totalQuestions: parseInt(ex.totalQuestions, 10) || 35,
        durationMinutes: ex.durationMinutes || 40,
        totalMarks: parseFloat(ex.totalMarks) || 35,
        negativeMark: parseFloat(ex.negativeMarking) || 0.25,
        difficulty: 'Subject Mastery'
      });
    }
  }

  // Stage 3: Faculty Section Patterns
  for (let i = 0; i < Math.min(sectionExams.length, 3); i++) {
    const ex = sectionExams[i];
    stage3Tests.push({
      id: `sec_${ex.id}`,
      slug: ex.id,
      title: `${university.code} Faculty Pattern: ${ex.title}`,
      subtitle: `Official Admission Mark Weightage Section`,
      pillar: 'sectionWise',
      dayNumber: Math.round(effectiveHorizon * 0.55) + i * 2,
      totalQuestions: parseInt(ex.totalQuestions, 10) || 30,
      durationMinutes: ex.durationMinutes || 35,
      totalMarks: parseFloat(ex.totalMarks) || 30,
      negativeMark: parseFloat(ex.negativeMarking) || 0.25,
      difficulty: 'Faculty Pattern'
    });
  }

  // Stage 4: Full Simulations
  const fullMocks = [...modelTests, ...pastPapers];
  for (let i = 0; i < Math.min(fullMocks.length, 4); i++) {
    const ex = fullMocks[i];
    stage4Tests.push({
      id: ex.id,
      slug: ex.id,
      title: ex.title,
      subtitle: `Full Timed Simulation • Hall Pressure & Negative Marking`,
      pillar: 'overall',
      dayNumber: Math.round(effectiveHorizon * 0.75) + i * 3,
      totalQuestions: parseInt(ex.totalQuestions, 10) || 50,
      durationMinutes: ex.durationMinutes || 60,
      totalMarks: parseFloat(ex.totalMarks) || 50,
      negativeMark: parseFloat(ex.negativeMarking) || 0.25,
      difficulty: 'Full Simulation Mock'
    });
  }

  const allPlanItems = [...stage1Tests, ...stage2Tests, ...stage3Tests, ...stage4Tests];
  allPlanItems.sort((a, b) => a.dayNumber - b.dayNumber);

  return {
    success: true,
    university: {
      id: university.id,
      code: university.code,
      fullName: university.fullName,
      shortName: university.shortName,
      logoUrl: university.logoUrl,
      campusLocation: university.campusLocation,
      examPatternSummary: university.examPatternSummary
    },
    availableTracks,
    activeTrack,
    upcomingCycle: {
      season: upcomingCycle?.season || 'Spring',
      academicYear: upcomingCycle?.academicYear || 2026,
      slotTitle: upcomingCycle?.slotTitle,
      examDate: examDate.toISOString(),
      daysRemaining: daysRemaining,
      venue: upcomingCycle?.venue
    },
    horizon: {
      days: effectiveHorizon,
      autoDays: autoHorizon
    },
    sections,
    stages: [
      {
        stageNumber: 1,
        title: 'Stage 1: High-Yield Topic Speed Drills',
        subtitle: 'Formula Accuracy & Rapid Error Spotting',
        testCount: stage1Tests.length,
        tests: stage1Tests
      },
      {
        stageNumber: 2,
        title: 'Stage 2: Subject Mastery Testing',
        subtitle: 'Comprehensive Core Subject Syllabus Integration',
        testCount: stage2Tests.length,
        tests: stage2Tests
      },
      {
        stageNumber: 3,
        title: 'Stage 3: Faculty Section Pattern Tests',
        subtitle: 'Exact University Mark Weightage Distribution',
        testCount: stage3Tests.length,
        tests: stage3Tests
      },
      {
        stageNumber: 4,
        title: 'Stage 4: Full Simulation Mocks & Past Papers',
        subtitle: 'Timed Exam Hall Pressure with Negative Marking Penalty',
        testCount: stage4Tests.length,
        tests: stage4Tests
      }
    ],
    allPlanItems
  };
}

async function run() {
  for (const uni of ['NSU', 'BRACU', 'AUST']) {
    console.log(`\n=================== ${uni} ===================`);
    const journey = await buildAdmissionJourney(uni, 'engineering', 30);
    console.log('Upcoming Cycle:', journey.upcomingCycle);
    console.log('Sections:', journey.sections);
    console.log('Available Tracks:', journey.availableTracks);
    console.log('Stages:');
    journey.stages.forEach(st => console.log(`  ${st.title} (${st.testCount} tests)`));
    console.log('Total Plan Items:', journey.allPlanItems.length);
  }
  await pool.end();
}

run();
