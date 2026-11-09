import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Pool } from 'pg';
import { RedisService } from '../redis/redis.service';
import { SupabaseAuthVerificationError, verifySupabaseAccessToken } from '../services/supabase_auth.service';
import { recordLearnerEvent } from '../services/learner_analytics.service';
import { sendInternalError } from '../services/http_errors';

export const onboardingRoutes: FastifyPluginAsync<{ db: Pool; redis: RedisService }> = async (
  app: FastifyInstance,
  opts: { db: Pool; redis: RedisService }
) => {
  const { db, redis } = opts;

  const OnboardingSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    phone: z.string().optional(),
    gender: z.string().optional().nullable(),
    divisionId: z.string().optional().nullable(),
    divisionName: z.string().optional().nullable(),
    districtId: z.string().optional().nullable(),
    districtName: z.string().optional().nullable(),
    medium: z.enum(['bangla', 'english']),
    nctbVersion: z.enum(['bangla', 'english']).optional().nullable(),
    englishCurriculum: z.enum(['cambridge', 'edexcel']).optional().nullable(),
    academicBatch: z.string().min(1),
    institutionName: z.string().min(1),
    institutionEiin: z.string().optional().nullable(),
    institutionId: z.string().optional().nullable(),
    sscGroup: z.string().optional().nullable(),
    sscYear: z.string().optional().nullable(),
    sscGpa: z.string().optional().nullable(),
    sscInstitution: z.string().optional().nullable(),
    sscEiin: z.string().optional().nullable(),
    hscGroup: z.string().optional().nullable(),
    hscBatch: z.string().optional().nullable(),
    hscGpa: z.string().optional().nullable(),
    hscInstitution: z.string().optional().nullable(),
    hscEiin: z.string().optional().nullable(),
    oLevelBoard: z.string().optional().nullable(),
    oLevelYear: z.string().optional().nullable(),
    oLevelSubjectsCount: z.number().optional().nullable(),
    oLevelGrades: z.string().optional().nullable(),
    oLevelGpaEquiv: z.string().optional().nullable(),
    oLevelSchool: z.string().optional().nullable(),
    oLevelInstitutionId: z.string().optional().nullable(),
    aLevelBoard: z.string().optional().nullable(),
    aLevelBatch: z.string().optional().nullable(),
    aLevelStatus: z.string().optional().nullable(),
    aLevelSubjectsCount: z.number().optional().nullable(),
    aLevelGrades: z.string().optional().nullable(),
    aLevelGpaEquiv: z.string().optional().nullable(),
    aLevelCollege: z.string().optional().nullable(),
    aLevelInstitutionId: z.string().optional().nullable(),
    targetSelections: z.record(z.array(z.string())),
    track: z.string().optional().default('private_uni'),
  });

  // 1. Submit Candidate Onboarding Profile (Persists to Supabase users table & Redis)
  app.post('/api/v1/user/onboarding', async (req: FastifyRequest, reply: FastifyReply) => {
    const parseResult = OnboardingSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.errors[0].message });
    }

    const data = parseResult.data;
    if (!db) return reply.status(503).send({ error: 'Profile storage is temporarily unavailable. Please try again later.' });

    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string' ? authorization.match(/^Bearer\s+(.+)$/i)?.[1] : null;
    if (!bearer) return reply.status(401).send({ error: 'Sign in to save your learner profile.' });
    // Learner identity comes only from Supabase Auth, never from server-signed JWTs.
    let userId: string;
    try {
      userId = (await verifySupabaseAccessToken(bearer)).id;
    } catch (err) {
      const statusCode = err instanceof SupabaseAuthVerificationError ? err.statusCode : 503;
      const message = err instanceof Error ? err.message : 'Candidate identity verification is unavailable.';
      return reply.status(statusCode).send({ error: message });
    }
    const targetUnis = Object.keys(data.targetSelections);
    const targetDisciplines = Object.values(data.targetSelections).flat();

    let firstCompletedOnboarding = false;
    try {
      const previousCompletion = await db.query(`SELECT EXISTS (
        SELECT 1 FROM public.users
        WHERE id=$1::uuid AND medium IS NOT NULL AND academic_batch IS NOT NULL
          AND institution_name IS NOT NULL AND jsonb_array_length(COALESCE(target_universities, '[]'::jsonb)) > 0
      ) AS complete`, [userId]);
      firstCompletedOnboarding = !previousCompletion.rows[0]?.complete;
    } catch (err) {
      req.log.warn({ err }, 'Unable to determine whether this is the first onboarding completion');
    }

    let savedUser: Record<string, unknown> | null = null;
    try {
        const query = `
          INSERT INTO users (
            id, full_name, phone, gender, division_id, division_name,
            district_id, district_name, medium, nctb_version, english_curriculum,
            academic_batch, institution_name, institution_eiin, institution_id,
            ssc_group, ssc_year, ssc_gpa, ssc_institution, ssc_eiin,
            hsc_group, hsc_batch, hsc_gpa, hsc_institution, hsc_eiin,
            o_level_board, o_level_year, o_level_subjects_count, o_level_grades, o_level_gpa_equiv, o_level_school, o_level_institution_id,
            a_level_board, a_level_batch, a_level_status, a_level_subjects_count, a_level_grades, a_level_gpa_equiv, a_level_college, a_level_institution_id,
            target_universities, target_disciplines, track, updated_at
          ) VALUES (
            COALESCE(NULLIF($1, '')::uuid, gen_random_uuid()), $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11,
            $12, $13, $14, CASE WHEN $15 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN $15::uuid ELSE NULL END,
            $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25,
            $26, $27, $28, $29, $30, $31, CASE WHEN $32 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN $32::uuid ELSE NULL END,
            $33, $34, $35, $36, $37, $38, $39, CASE WHEN $40 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN $40::uuid ELSE NULL END,
            $41::jsonb, $42::jsonb, $43, NOW()
          )
          ON CONFLICT (id) DO UPDATE SET
            full_name = EXCLUDED.full_name,
            phone = COALESCE(EXCLUDED.phone, users.phone),
            gender = EXCLUDED.gender,
            division_id = EXCLUDED.division_id,
            division_name = EXCLUDED.division_name,
            district_id = EXCLUDED.district_id,
            district_name = EXCLUDED.district_name,
            medium = EXCLUDED.medium,
            nctb_version = EXCLUDED.nctb_version,
            english_curriculum = EXCLUDED.english_curriculum,
            academic_batch = EXCLUDED.academic_batch,
            institution_name = EXCLUDED.institution_name,
            institution_eiin = EXCLUDED.institution_eiin,
            institution_id = EXCLUDED.institution_id,
            ssc_group = EXCLUDED.ssc_group,
            ssc_year = EXCLUDED.ssc_year,
            ssc_gpa = EXCLUDED.ssc_gpa,
            ssc_institution = EXCLUDED.ssc_institution,
            ssc_eiin = EXCLUDED.ssc_eiin,
            hsc_group = EXCLUDED.hsc_group,
            hsc_batch = EXCLUDED.hsc_batch,
            hsc_gpa = EXCLUDED.hsc_gpa,
            hsc_institution = EXCLUDED.hsc_institution,
            hsc_eiin = EXCLUDED.hsc_eiin,
            o_level_board = EXCLUDED.o_level_board,
            o_level_year = EXCLUDED.o_level_year,
            o_level_subjects_count = EXCLUDED.o_level_subjects_count,
            o_level_grades = EXCLUDED.o_level_grades,
            o_level_gpa_equiv = EXCLUDED.o_level_gpa_equiv,
            o_level_school = EXCLUDED.o_level_school,
            o_level_institution_id = EXCLUDED.o_level_institution_id,
            a_level_board = EXCLUDED.a_level_board,
            a_level_batch = EXCLUDED.a_level_batch,
            a_level_status = EXCLUDED.a_level_status,
            a_level_subjects_count = EXCLUDED.a_level_subjects_count,
            a_level_grades = EXCLUDED.a_level_grades,
            a_level_gpa_equiv = EXCLUDED.a_level_gpa_equiv,
            a_level_college = EXCLUDED.a_level_college,
            a_level_institution_id = EXCLUDED.a_level_institution_id,
            target_universities = EXCLUDED.target_universities,
            target_disciplines = EXCLUDED.target_disciplines,
            track = EXCLUDED.track,
            updated_at = NOW()
          RETURNING *;
        `;
        const res = await db.query(query, [
          userId,
          data.name,
          data.phone || null,
          data.gender || null,
          data.divisionId || null,
          data.divisionName || null,
          data.districtId || null,
          data.districtName || null,
          data.medium,
          data.nctbVersion || null,
          data.englishCurriculum || null,
          data.academicBatch,
          data.institutionName,
          data.institutionEiin || null,
          data.institutionId || null,
          data.sscGroup || null,
          data.sscYear || null,
          data.sscGpa || null,
          data.sscInstitution || null,
          data.sscEiin || null,
          data.hscGroup || null,
          data.hscBatch || null,
          data.hscGpa || null,
          data.hscInstitution || null,
          data.hscEiin || null,
          data.oLevelBoard || null,
          data.oLevelYear || null,
          data.oLevelSubjectsCount || null,
          data.oLevelGrades || null,
          data.oLevelGpaEquiv || null,
          data.oLevelSchool || null,
          data.oLevelInstitutionId || null,
          data.aLevelBoard || null,
          data.aLevelBatch || null,
          data.aLevelStatus || null,
          data.aLevelSubjectsCount || null,
          data.aLevelGrades || null,
          data.aLevelGpaEquiv || null,
          data.aLevelCollege || null,
          data.aLevelInstitutionId || null,
          JSON.stringify(targetUnis),
          JSON.stringify(data.targetSelections),
          data.track,
        ]);
      savedUser = res.rows[0] || null;
      if (!savedUser) {
        req.log.error('Onboarding profile write returned no persisted user row');
        return reply.status(503).send({ error: 'Your profile could not be saved. Please try again later.' });
      }
    } catch (err: any) {
      req.log.error({ err }, 'Failed to persist onboarding profile');
      return reply.status(503).send({ error: 'Your profile could not be saved. Please try again later.' });
    }

    // Redis mirrors the durable profile for fast reads; a cache outage must not
    // turn a committed profile write into a failed save response.
    try {
      await redis.set(`profile:${userId}`, JSON.stringify({ ...data, id: userId }), 86400 * 30);
    } catch (err) {
      req.log.warn({ err }, 'Onboarding profile saved but Redis cache refresh failed');
    }

    // Optional product analytics are recorded only after a durable profile save and active consent.
    if (firstCompletedOnboarding) {
      try { await recordLearnerEvent(db, userId, 'onboarding_completed'); }
      catch (err) { req.log.warn({ err }, 'Optional onboarding analytics event was not recorded'); }
    }

    return {
      success: true,
      message: 'Candidate profile saved successfully',
      user: savedUser,
      targetCount: targetUnis.length,
    };
  });

  // 1.1 Fetch Candidate Profile from Supabase / Redis
  app.get('/api/v1/user/profile', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string' ? authorization.match(/^Bearer\s+(.+)$/i)?.[1] : null;
    if (!bearer) return reply.status(401).send({ error: 'Sign in to fetch your profile.' });

    let userId: string;
    try {
      userId = (await verifySupabaseAccessToken(bearer)).id;
    } catch (err) {
      const statusCode = err instanceof SupabaseAuthVerificationError ? err.statusCode : 503;
      return reply.status(statusCode).send({ error: err instanceof Error ? err.message : 'Candidate identity verification is unavailable.' });
    }

    try {
      const cached = await redis.get(`profile:${userId}`);
      if (cached) {
        return { success: true, profile: JSON.parse(cached) };
      }
    } catch (_) {}

    try {
      const res = await db.query('SELECT * FROM public.users WHERE id = $1::uuid', [userId]);
      if (res.rows.length === 0) {
        return { success: true, profile: null };
      }
      const row = res.rows[0];

      let targets: Record<string, string[]> = {};
      if (row.target_disciplines && typeof row.target_disciplines === 'object' && !Array.isArray(row.target_disciplines)) {
        targets = row.target_disciplines as Record<string, string[]>;
      } else if (Array.isArray(row.target_universities)) {
        for (const u of row.target_universities) {
          targets[u] = [u];
        }
      }

      const profile = {
        id: row.id,
        name: row.full_name || '',
        phone: row.phone || '',
        gender: row.gender,
        divisionId: row.division_id,
        divisionName: row.division_name,
        districtId: row.district_id,
        districtName: row.district_name,
        medium: row.medium || 'bangla',
        nctbVersion: row.nctb_version,
        englishCurriculum: row.english_curriculum,
        academicBatch: row.academic_batch || "HSC '25",
        institutionName: row.institution_name || '',
        institutionEiin: row.institution_eiin,
        sscGroup: row.ssc_group,
        sscYear: row.ssc_year,
        sscGpa: row.ssc_gpa,
        sscInstitution: row.ssc_institution,
        sscEiin: row.ssc_eiin,
        hscGroup: row.hsc_group,
        hscBatch: row.hsc_batch,
        hscGpa: row.hsc_gpa,
        hscInstitution: row.hsc_institution,
        hscEiin: row.hsc_eiin,
        oLevelBoard: row.o_level_board,
        oLevelYear: row.o_level_year,
        oLevelSubjectsCount: row.o_level_subjects_count,
        oLevelGrades: row.o_level_grades,
        oLevelGpaEquiv: row.o_level_gpa_equiv,
        oLevelSchool: row.o_level_school,
        oLevelInstitutionId: row.o_level_institution_id,
        aLevelBoard: row.a_level_board,
        aLevelBatch: row.a_level_batch,
        aLevelStatus: row.a_level_status,
        aLevelSubjectsCount: row.a_level_subjects_count,
        aLevelGrades: row.a_level_grades,
        aLevelGpaEquiv: row.a_level_gpa_equiv,
        aLevelCollege: row.a_level_college,
        aLevelInstitutionId: row.a_level_institution_id,
        studyStreakDays: row.streak_days || 0,
        targetSelections: targets,
      };

      try {
        await redis.set(`profile:${userId}`, JSON.stringify(profile), 86400 * 30);
      } catch (_) {}

      return { success: true, profile };
    } catch (err: any) {
      req.log.error({ err }, 'Failed to fetch candidate profile');
      return reply.status(503).send({ error: 'Unable to retrieve profile from database.' });
    }
  });

  // 2. Private Universities & Programs Dynamic Catalog from Supabase
  app.get('/api/v1/private-uni/catalog', async (_req, reply: FastifyReply) => {
    if (!db) {
      return reply.status(503).send({ error: 'Database service unavailable' });
    }

    try {
      // Query universities joined with academic units, programs, and fee structures
      const uniQuery = `
        SELECT 
          u.id,
          u.slug,
          u.code,
          u.full_name AS "fullName",
          u.short_name AS "shortName",
          u.academic_system AS "academicSystem",
          u.campus_location AS "campusLocation",
          u.website_url AS "websiteUrl",
          u.admission_portal_url AS "admissionPortalUrl",
          COALESCE(
            json_agg(
              json_build_object(
                'id', p.id,
                'slug', p.slug,
                'name', p.name,
                'degreeType', p.degree_type,
                'trackCategory', p.track_category,
                'totalCredits', p.total_credits,
                'durationYears', p.duration_years
              )
            ) FILTER (WHERE p.id IS NOT NULL), '[]'
          ) AS programs
        FROM universities u
        LEFT JOIN programs p ON p.university_id = u.id AND p.is_active = true
        WHERE u.is_active = true
        GROUP BY u.id
        ORDER BY u.code;
      `;
      const uniRes = await db.query(uniQuery);

      // Query admission test patterns
      const patternQuery = `
        SELECT 
          id,
          university_id AS "universityId",
          slug,
          pattern_name AS "patternName",
          test_archetype AS "testArchetype",
          total_marks AS "totalMarks",
          duration_minutes AS "durationMinutes",
          has_negative_marking AS "hasNegativeMarking",
          negative_marking_penalty AS "negativeMarkingPenalty",
          sections
        FROM admission_test_patterns;
      `;
      const patternRes = await db.query(patternQuery);

      return {
        success: true,
        count: uniRes.rows.length,
        universities: uniRes.rows,
        admissionPatterns: patternRes.rows,
      };
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });
};
