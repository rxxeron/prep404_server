import { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { sendInternalError } from '../services/http_errors';

export const admissionJourneyRoutes: FastifyPluginAsync<{ db: Pool }> = async (
  app: FastifyInstance,
  opts: { db: Pool }
) => {
  const { db } = opts;

  // Complete Admission Test Journey Pipeline (100% Database-Driven)
  app.get<{
    Querystring: {
      universityCode?: string;
      category?: string;
      horizon?: string;
    };
  }>('/api/v1/admission-plan/journey', async (req, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    try {
      const targetUni = (req.query.universityCode || 'BRACU').trim().toUpperCase();
      const requestedTrack = (req.query.category || '').trim().toLowerCase();
      const horizonDays = parseInt(req.query.horizon || '0', 10);

      // 1. Fetch University from database
      const uniRes = await db.query(`
        SELECT id, code, full_name AS "fullName", short_name AS "shortName", logo_url AS "logoUrl",
               campus_location AS "campusLocation", exam_pattern_summary AS "examPatternSummary"
        FROM universities
        WHERE UPPER(code) = $1 OR UPPER(slug) = $1 OR UPPER(short_name) = $1
        LIMIT 1;
      `, [targetUni]);

      if (uniRes.rows.length === 0) {
        return reply.status(404).send({ error: `University '${targetUni}' not found in database` });
      }
      const university = uniRes.rows[0];

      // 2. Fetch Programs & Available Tracks from database
      const progsRes = await db.query(`
        SELECT id, name, slug, track_category AS "trackCategory", degree_type AS "degreeType"
        FROM programs
        WHERE university_id = $1 AND is_active = true
        ORDER BY track_category ASC, name ASC;
      `, [university.id]);

      const availableTracks = Array.from(new Set(progsRes.rows.map((p: any) => p.trackCategory)));
      const activeTrack = availableTracks.includes(requestedTrack)
        ? requestedTrack
        : (availableTracks.includes('engineering') ? 'engineering' : (availableTracks[0] || 'engineering'));

      // 3. Fetch Cycles & Upcoming Exam Date from database
      const cyclesRes = await db.query(`
        SELECT id, season, academic_year AS "academicYear", slot_number AS "slotNumber",
               slot_title AS "slotTitle", application_deadline AS "applicationDeadline",
               exam_date AS "examDate", exam_time AS "examTime", application_fee AS "applicationFee",
               venue, status
        FROM admission_cycles
        WHERE university_id = $1
        ORDER BY exam_date ASC;
      `, [university.id]);

      const now = new Date();
      const upcomingCycle = cyclesRes.rows.find((c: any) => new Date(c.examDate) >= now && c.status === 'upcoming') ||
        cyclesRes.rows.find((c: any) => new Date(c.examDate) >= now) ||
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
      const patternsRes = await db.query(`
        SELECT id, pattern_name AS "patternName", test_archetype AS "testArchetype",
               total_marks AS "totalMarks", duration_minutes AS "durationMinutes",
               has_negative_marking AS "hasNegativeMarking",
               negative_marking_penalty AS "negativeMarkingPenalty",
               slug,
               sections
        FROM admission_test_patterns
        WHERE university_id = $1;
      `, [university.id]);

      let pattern = patternsRes.rows.find((p: any) => {
        const pSlug = (p.slug || '').toLowerCase();
        const pArch = (p.testArchetype || '').toLowerCase();
        const pName = (p.patternName || '').toLowerCase();

        if (activeTrack === 'business') {
          return pSlug.includes('bba') || pSlug.includes('bus') || pArch.includes('bba') || pName.includes('bus') || pName.includes('bba');
        }
        if (activeTrack === 'engineering') {
          return pSlug === 'eng' || pSlug.includes('eng') || pArch.includes('eng') || pName.includes('eng');
        }
        if (activeTrack === 'architecture') {
          return pSlug.includes('arch') || pArch.includes('arch') || pName.includes('arch');
        }
        if (activeTrack === 'pharmacy') {
          return pSlug.includes('pharm') || pArch.includes('pharm') || pName.includes('pharm') || pName.includes('bio');
        }
        if (activeTrack === 'law') {
          return pSlug.includes('law') || pArch.includes('law') || pName.includes('law');
        }
        if (activeTrack === 'sciences') {
          return pSlug.includes('sci') || pArch.includes('sci') || pName.includes('sci');
        }
        if (activeTrack === 'humanities') {
          return pSlug.includes('hum') || pSlug.includes('arts') || pName.includes('human') || pName.includes('arts');
        }
        return false;
      }) || patternsRes.rows[0];

      const rawSections = pattern ? (pattern.sections || []) : [];
      let totalSectionMarks = 0;
      rawSections.forEach((s: any) => totalSectionMarks += (s.marks || s.questions || 20));
      if (totalSectionMarks === 0) totalSectionMarks = 100;

      const colorPalette = ['#FF7A36', '#FFD166', '#BA467A', '#10B981', '#3B82F6'];
      const sections = rawSections.map((s: any, idx: number) => {
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
      const examsRes = await db.query(`
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

      const relevantExams = allExams.filter((e: any) => {
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

      const sectionExams = relevantExams.filter((e: any) => e.examType === 'section_exam');
      const modelTests = relevantExams.filter((e: any) => e.examType === 'model_test' || e.examType === 'daily_live');
      const pastPapers = relevantExams.filter((e: any) => e.examType === 'uni_exam');
      const fullMocks = [...modelTests, ...pastPapers];

      type MilestoneSpec = {
        pillar: 'topicWise' | 'subjectWise' | 'sectionWise' | 'overall';
        dayNumber: number;
        sessionSlot: string;
      };

      const milestoneSpecs: MilestoneSpec[] = [];

      if (effectiveHorizon <= 10) {
        for (let d = 1; d <= 4; d++) {
          milestoneSpecs.push({ pillar: 'topicWise', dayNumber: d, sessionSlot: 'Morning Drill' });
          milestoneSpecs.push({ pillar: 'topicWise', dayNumber: d, sessionSlot: 'Evening Drill' });
        }
        for (let d = 5; d <= 6; d++) {
          milestoneSpecs.push({ pillar: 'subjectWise', dayNumber: d, sessionSlot: 'Morning Drill' });
          milestoneSpecs.push({ pillar: 'subjectWise', dayNumber: d, sessionSlot: 'Evening Drill' });
        }
        milestoneSpecs.push({ pillar: 'subjectWise', dayNumber: 7, sessionSlot: 'Morning Drill' });
        milestoneSpecs.push({ pillar: 'sectionWise', dayNumber: 7, sessionSlot: 'Evening Drill' });
        milestoneSpecs.push({ pillar: 'sectionWise', dayNumber: 8, sessionSlot: 'Morning Drill' });
        milestoneSpecs.push({ pillar: 'sectionWise', dayNumber: 8, sessionSlot: 'Evening Drill' });
        milestoneSpecs.push({ pillar: 'sectionWise', dayNumber: 9, sessionSlot: 'Morning Drill' });
        milestoneSpecs.push({ pillar: 'overall', dayNumber: 9, sessionSlot: 'Evening Mock' });
        milestoneSpecs.push({ pillar: 'overall', dayNumber: 10, sessionSlot: 'Morning Mock' });
        milestoneSpecs.push({ pillar: 'overall', dayNumber: 10, sessionSlot: 'Evening Conquest' });
      } else if (effectiveHorizon <= 15) {
        for (let d = 1; d <= 6; d++) {
          milestoneSpecs.push({ pillar: 'topicWise', dayNumber: d, sessionSlot: 'Daily Drill' });
        }
        for (let d = 7; d <= 10; d++) {
          milestoneSpecs.push({ pillar: 'subjectWise', dayNumber: d, sessionSlot: 'Daily Drill' });
        }
        for (let d = 11; d <= 13; d++) {
          milestoneSpecs.push({ pillar: 'sectionWise', dayNumber: d, sessionSlot: 'Daily Drill' });
        }
        milestoneSpecs.push({ pillar: 'overall', dayNumber: 14, sessionSlot: 'Simulation Mock' });
        milestoneSpecs.push({ pillar: 'overall', dayNumber: 14, sessionSlot: 'Section Review' });
        milestoneSpecs.push({ pillar: 'overall', dayNumber: 15, sessionSlot: 'Final Conquest Mock' });
      } else if (effectiveHorizon <= 35) {
        const relaxedSchedule: { pillar: 'topicWise' | 'subjectWise' | 'sectionWise' | 'overall'; day: number }[] = [
          { pillar: 'topicWise', day: 1 },
          { pillar: 'topicWise', day: 3 },
          { pillar: 'topicWise', day: 6 },
          { pillar: 'topicWise', day: 9 },
          { pillar: 'subjectWise', day: 12 },
          { pillar: 'subjectWise', day: 15 },
          { pillar: 'subjectWise', day: 18 },
          { pillar: 'sectionWise', day: 21 },
          { pillar: 'sectionWise', day: 24 },
          { pillar: 'overall', day: 27 },
          { pillar: 'overall', day: 29 },
          { pillar: 'overall', day: 30 }
        ];
        for (const item of relaxedSchedule) {
          milestoneSpecs.push({
            pillar: item.pillar,
            dayNumber: item.day,
            sessionSlot: 'Relaxed Milestone'
          });
        }
      } else {
        const foundationSchedule: { pillar: 'topicWise' | 'subjectWise' | 'sectionWise' | 'overall'; day: number }[] = [
          { pillar: 'topicWise', day: 1 },
          { pillar: 'topicWise', day: 6 },
          { pillar: 'topicWise', day: 12 },
          { pillar: 'topicWise', day: 18 },
          { pillar: 'subjectWise', day: 24 },
          { pillar: 'subjectWise', day: 30 },
          { pillar: 'subjectWise', day: 36 },
          { pillar: 'sectionWise', day: 42 },
          { pillar: 'sectionWise', day: 48 },
          { pillar: 'overall', day: 54 },
          { pillar: 'overall', day: 58 },
          { pillar: 'overall', day: 60 }
        ];
        for (const item of foundationSchedule) {
          milestoneSpecs.push({
            pillar: item.pillar,
            dayNumber: item.day,
            sessionSlot: 'Foundation Milestone'
          });
        }
      }

      let topicIdx = 0;
      let subjectIdx = 0;
      let sectionIdx = 0;
      let mockIdx = 0;

      const stage1Tests: any[] = [];
      const stage2Tests: any[] = [];
      const stage3Tests: any[] = [];
      const stage4Tests: any[] = [];
      const allPlanItems: any[] = [];

      for (let i = 0; i < milestoneSpecs.length; i++) {
        const spec = milestoneSpecs[i];
        let ex: any = null;
        let difficulty = 'High-Yield Drill';
        let subtitle = '';
        let title = '';
        let id = '';

        if (spec.pillar === 'topicWise') {
          ex = sectionExams[topicIdx % Math.max(1, sectionExams.length)];
          topicIdx++;
          title = ex?.title || `${university.code} Topic Speed Drill #${topicIdx}`;
          subtitle = `${ex?.totalQuestions || 25} Questions • Fast Speed Drill`;
          difficulty = 'High-Yield Drill';
          id = ex?.id || `topic_${i + 1}`;
        } else if (spec.pillar === 'subjectWise') {
          ex = sectionExams[(sectionExams.length - 1 - subjectIdx) % Math.max(1, sectionExams.length)];
          subjectIdx++;
          title = ex?.title || `${university.code} Subject Mastery Drill #${subjectIdx}`;
          subtitle = 'Comprehensive Subject Syllabus Integration';
          difficulty = 'Subject Mastery';
          id = ex?.id || `subj_${i + 1}`;
        } else if (spec.pillar === 'sectionWise') {
          ex = sectionExams[(sectionIdx * 3 + 1) % Math.max(1, sectionExams.length)];
          sectionIdx++;
          title = `${university.code} Faculty Pattern: ${ex?.title || 'Section Pattern'}`;
          subtitle = 'Official Admission Mark Weightage Section';
          difficulty = 'Faculty Pattern';
          id = `sec_${ex?.id || i + 1}`;
        } else {
          ex = fullMocks[mockIdx % Math.max(1, fullMocks.length)];
          mockIdx++;
          title = ex?.title || `${university.code} Full Admission Simulation Mock #${mockIdx}`;
          subtitle = 'Timed Exam Hall Pressure with Negative Marking';
          difficulty = 'Full Simulation Mock';
          id = ex?.id || `mock_${i + 1}`;
        }

        const slotTag = spec.sessionSlot.includes('Morning')
          ? 'Morning'
          : (spec.sessionSlot.includes('Evening') ? 'Evening' : '');
        const displayDay = slotTag ? `Day ${spec.dayNumber} · ${slotTag}` : `Day ${spec.dayNumber}`;

        const item = {
          id: id,
          slug: ex?.id || id,
          title: title,
          subtitle: subtitle,
          pillar: spec.pillar,
          dayNumber: spec.dayNumber,
          sessionSlot: spec.sessionSlot,
          displayDay: displayDay,
          totalQuestions: parseInt(ex?.totalQuestions, 10) || 30,
          durationMinutes: ex?.durationMinutes || 30,
          totalMarks: parseFloat(ex?.totalMarks) || 30,
          negativeMark: parseFloat(ex?.negativeMarking) || 0.25,
          difficulty: difficulty
        };

        if (spec.pillar === 'topicWise') stage1Tests.push(item);
        else if (spec.pillar === 'subjectWise') stage2Tests.push(item);
        else if (spec.pillar === 'sectionWise') stage3Tests.push(item);
        else stage4Tests.push(item);

        allPlanItems.push(item);
      }

      const pLabel = effectiveHorizon <= 10
        ? 'High-Intensity Blitz'
        : (effectiveHorizon <= 15
          ? 'Accelerated Intensive'
          : (effectiveHorizon <= 35 ? 'Relaxed & Balanced' : 'Deep Foundation'));
      const dFreq = effectiveHorizon <= 10
        ? '2.0 Tests / Day'
        : (effectiveHorizon <= 15
          ? '~1.1 Tests / Day'
          : (effectiveHorizon <= 35 ? '1 Test / 2-3 Days' : '1 Test / 5 Days'));
      const cDesc = effectiveHorizon <= 10
        ? 'High daily test frequency (2 tests/day) for rapid error spotting and formula speed'
        : (effectiveHorizon <= 15
          ? 'Daily testing progression with checkpoint simulations'
          : (effectiveHorizon <= 35
            ? 'Relaxed pacing with dedicated textbook study & rest days between tests'
            : 'Deep chapter learning buffers between milestone tests'));

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
          autoDays: autoHorizon,
          pacingLabel: pLabel,
          dailyFrequency: dFreq,
          cadenceDescription: cDesc
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
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // Dynamic Admission Patterns API (Decoupled from client hardcoding)
  app.get<{
    Querystring: {
      universityCode?: string;
      category?: string;
    };
  }>('/api/v1/admission-plan/patterns', async (req, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    try {
      const uniCode = req.query.universityCode ? req.query.universityCode.trim().toUpperCase() : null;
      const requestedCategory = req.query.category ? req.query.category.trim().toLowerCase() : null;

      let query = `
        SELECT 
          u.id AS "universityId",
          u.code AS "universityCode",
          u.slug AS "universitySlug",
          u.full_name AS "fullName",
          u.short_name AS "shortName",
          u.logo_url AS "logoUrl",
          p.id AS "patternId",
          p.slug AS "patternSlug",
          p.pattern_name AS "patternName",
          p.test_archetype AS "testArchetype",
          p.total_marks AS "totalMarks",
          p.duration_minutes AS "durationMinutes",
          p.has_negative_marking AS "hasNegativeMarking",
          p.negative_marking_penalty AS "negativeMarkingPenalty",
          p.sections
        FROM universities u
        JOIN admission_test_patterns p ON p.university_id = u.id
        WHERE u.is_active = true
      `;
      const params: any[] = [];
      if (uniCode) {
        params.push(uniCode);
        query += ` AND (UPPER(u.code) = $${params.length} OR UPPER(u.slug) = $${params.length} OR UPPER(u.short_name) = $${params.length})`;
      }
      query += ` ORDER BY u.code, p.pattern_name;`;

      const res = await db.query(query, params);

      let rows = res.rows;
      if (requestedCategory) {
        rows = rows.filter((r: any) => {
          const slug = (r.patternSlug || '').toLowerCase();
          const arch = (r.testArchetype || '').toLowerCase();
          const name = (r.patternName || '').toLowerCase();
          if (requestedCategory === 'business' || requestedCategory === 'bba') {
            return slug.includes('bba') || slug.includes('bus') || arch.includes('bba') || name.includes('bus') || name.includes('bba');
          }
          if (requestedCategory === 'engineering' || requestedCategory === 'eng') {
            return slug === 'eng' || slug.includes('eng') || arch.includes('eng') || name.includes('eng');
          }
          if (requestedCategory === 'architecture' || requestedCategory === 'arch') {
            return slug.includes('arch') || arch.includes('arch') || name.includes('arch');
          }
          if (requestedCategory === 'pharmacy' || requestedCategory === 'pharm') {
            return slug.includes('pharm') || arch.includes('pharm') || name.includes('pharm') || name.includes('bio');
          }
          if (requestedCategory === 'law') {
            return slug.includes('law') || arch.includes('law') || name.includes('law');
          }
          return true;
        });
      }

      return {
        success: true,
        count: rows.length,
        patterns: rows,
      };
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });
};
