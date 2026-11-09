import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Pool } from 'pg';
import crypto from 'crypto';
import { RedisService } from '../redis/redis.service';
import { requireStaffRole } from '../middleware/rbac.middleware';
import { sendInternalError } from '../services/http_errors';

export const academicManagementRoutes: FastifyPluginAsync<{ db: Pool; redis: RedisService }> = async (
  app: FastifyInstance,
  opts: { db: Pool; redis: RedisService }
) => {
  const { db } = opts;

  // =========================================================================
  // 1. UNIVERSITIES & ADMISSION TEST PATTERNS & PROGRAMS
  // =========================================================================

  // List all universities with patterns & program counts
  app.get(
    '/api/v1/management/academic/universities',
    { preHandler: [requireStaffRole(['setter', 'moderator', 'scheduler', 'super_admin'])] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      try {
        const result = await db.query(`
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
            u.is_active AS "isActive",
            u.exam_format_type AS "examFormatType",
            u.exam_pattern_summary AS "examPatternSummary",
            u.logo_url AS "logoUrl",
            (SELECT COUNT(*)::int FROM public.admission_test_patterns p WHERE p.university_id = u.id) AS "patternCount",
            (SELECT COUNT(*)::int FROM public.programs pr WHERE pr.university_id = u.id) AS "programCount",
            (SELECT COUNT(*)::int FROM public.exams e WHERE e.target_university_id = u.id) AS "examCount"
          FROM public.universities u
          ORDER BY u.full_name ASC;
        `);
        return { success: true, count: result.rows.length, universities: result.rows };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // Get single university with full details, all test patterns, and programs
  app.get<{ Params: { id: string } }>(
    '/api/v1/management/academic/universities/:id',
    { preHandler: [requireStaffRole(['setter', 'moderator', 'scheduler', 'super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      try {
        const uniRes = await db.query(`
          SELECT 
            u.id, u.slug, u.code, u.full_name AS "fullName", u.short_name AS "shortName",
            u.academic_system AS "academicSystem", u.campus_location AS "campusLocation",
            u.website_url AS "websiteUrl", u.admission_portal_url AS "admissionPortalUrl",
            u.is_active AS "isActive", u.exam_format_type AS "examFormatType",
            u.exam_pattern_summary AS "examPatternSummary", u.logo_url AS "logoUrl"
          FROM public.universities u WHERE u.id = $1::uuid LIMIT 1
        `, [req.params.id]);

        if (!uniRes.rowCount) return reply.status(404).send({ error: 'University not found' });
        const uni = uniRes.rows[0];

        const [patternsRes, programsRes] = await Promise.all([
          db.query(`
            SELECT 
              p.id, p.university_id AS "universityId", p.slug, p.pattern_name AS "patternName",
              p.test_archetype AS "testArchetype", p.total_marks AS "totalMarks",
              p.duration_minutes AS "durationMinutes", p.has_negative_marking AS "hasNegativeMarking",
              p.negative_marking_penalty AS "negativeMarkingPenalty", p.has_viva AS "hasViva",
              p.sections, p.created_at AS "createdAt"
            FROM public.admission_test_patterns p
            WHERE p.university_id = $1::uuid
            ORDER BY p.pattern_name ASC
          `, [uni.id]),
          db.query(`
            SELECT 
              pr.id, pr.university_id AS "universityId", pr.slug, pr.name,
              pr.degree_type AS "degreeType", pr.track_category AS "trackCategory",
              pr.total_credits AS "totalCredits", pr.duration_years AS "durationYears",
              pr.is_active AS "isActive"
            FROM public.programs pr
            WHERE pr.university_id = $1::uuid
            ORDER BY pr.name ASC
          `, [uni.id]),
        ]);

        return {
          success: true,
          university: uni,
          patterns: patternsRes.rows,
          programs: programsRes.rows,
        };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // Update University
  app.put<{ Params: { id: string } }>(
    '/api/v1/management/academic/universities/:id',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const schema = z.object({
        fullName: z.string().trim().min(2).max(200).optional(),
        shortName: z.string().trim().max(100).optional(),
        code: z.string().trim().max(50).optional(),
        academicSystem: z.string().trim().max(50).optional().nullable(),
        campusLocation: z.string().trim().max(200).optional().nullable(),
        websiteUrl: z.string().trim().max(500).optional().nullable(),
        admissionPortalUrl: z.string().trim().max(500).optional().nullable(),
        examFormatType: z.string().trim().max(50).optional().nullable(),
        examPatternSummary: z.string().trim().optional().nullable(),
        logoUrl: z.string().trim().max(500).optional().nullable(),
        isActive: z.boolean().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      const d = parsed.data;

      try {
        const updateRes = await db.query(`
          UPDATE public.universities
          SET 
            full_name = COALESCE($2, full_name),
            short_name = COALESCE($3, short_name),
            code = COALESCE($4, code),
            academic_system = COALESCE($5, academic_system),
            campus_location = COALESCE($6, campus_location),
            website_url = COALESCE($7, website_url),
            admission_portal_url = COALESCE($8, admission_portal_url),
            exam_format_type = COALESCE($9, exam_format_type),
            exam_pattern_summary = COALESCE($10, exam_pattern_summary),
            logo_url = COALESCE($11, logo_url),
            is_active = COALESCE($12, is_active),
            updated_at = NOW()
          WHERE id = $1::uuid
          RETURNING *;
        `, [
          req.params.id,
          d.fullName,
          d.shortName,
          d.code,
          d.academicSystem,
          d.campusLocation,
          d.websiteUrl,
          d.admissionPortalUrl,
          d.examFormatType,
          d.examPatternSummary,
          d.logoUrl,
          d.isActive,
        ]);
        if (!updateRes.rowCount) return reply.status(404).send({ error: 'University not found' });
        return { success: true, university: updateRes.rows[0] };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // Create University
  app.post(
    '/api/v1/management/academic/universities',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const schema = z.object({
        fullName: z.string().trim().min(2).max(200),
        shortName: z.string().trim().min(2).max(100),
        code: z.string().trim().min(2).max(50),
        academicSystem: z.string().trim().max(50).default('semester'),
        campusLocation: z.string().trim().max(200).optional().nullable(),
        websiteUrl: z.string().trim().max(500).optional().nullable(),
        admissionPortalUrl: z.string().trim().max(500).optional().nullable(),
        examFormatType: z.string().trim().max(50).default('centralized'),
        examPatternSummary: z.string().trim().optional().nullable(),
        logoUrl: z.string().trim().max(500).optional().nullable(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      const d = parsed.data;
      const slug = d.code.toLowerCase().replace(/[^a-z0-9]/g, '-');

      try {
        const ins = await db.query(`
          INSERT INTO public.universities (
            slug, code, full_name, short_name, academic_system, campus_location,
            website_url, admission_portal_url, exam_format_type, exam_pattern_summary,
            logo_url, is_active
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
          RETURNING *;
        `, [slug, d.code.toUpperCase(), d.fullName, d.shortName, d.academicSystem, d.campusLocation, d.websiteUrl, d.admissionPortalUrl, d.examFormatType, d.examPatternSummary, d.logoUrl]);
        return { success: true, university: ins.rows[0] };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // Create or Update Admission Test Pattern for a University
  app.post<{ Params: { id: string } }>(
    '/api/v1/management/academic/universities/:id/patterns',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const schema = z.object({
        patternName: z.string().trim().min(3).max(200),
        testArchetype: z.string().trim().max(50).default('standard'),
        totalMarks: z.number().int().min(1).max(2000).default(100),
        durationMinutes: z.number().int().min(1).max(300).default(60),
        hasNegativeMarking: z.boolean().default(true),
        negativeMarkingPenalty: z.number().min(0).max(10).default(0.25),
        hasViva: z.boolean().default(false),
        sections: z.array(z.any()).default([]),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      const d = parsed.data;
      const slug = d.patternName.toLowerCase().replace(/[^a-z0-9]/g, '-');

      try {
        const ins = await db.query(`
          INSERT INTO public.admission_test_patterns (
            university_id, slug, pattern_name, test_archetype, total_marks,
            duration_minutes, has_negative_marking, negative_marking_penalty,
            has_viva, sections
          ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
          RETURNING *;
        `, [
          req.params.id,
          slug,
          d.patternName,
          d.testArchetype,
          d.totalMarks,
          d.durationMinutes,
          d.hasNegativeMarking,
          d.negativeMarkingPenalty,
          d.hasViva,
          JSON.stringify(d.sections),
        ]);
        return { success: true, pattern: ins.rows[0] };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // Update Admission Test Pattern
  app.put<{ Params: { patternId: string } }>(
    '/api/v1/management/academic/patterns/:patternId',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const schema = z.object({
        patternName: z.string().trim().min(3).max(200).optional(),
        testArchetype: z.string().trim().max(50).optional(),
        totalMarks: z.number().int().min(1).max(2000).optional(),
        durationMinutes: z.number().int().min(1).max(300).optional(),
        hasNegativeMarking: z.boolean().optional(),
        negativeMarkingPenalty: z.number().min(0).max(10).optional(),
        hasViva: z.boolean().optional(),
        sections: z.array(z.any()).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      const d = parsed.data;

      try {
        const updateRes = await db.query(`
          UPDATE public.admission_test_patterns
          SET 
            pattern_name = COALESCE($2, pattern_name),
            test_archetype = COALESCE($3, test_archetype),
            total_marks = COALESCE($4, total_marks),
            duration_minutes = COALESCE($5, duration_minutes),
            has_negative_marking = COALESCE($6, has_negative_marking),
            negative_marking_penalty = COALESCE($7, negative_marking_penalty),
            has_viva = COALESCE($8, has_viva),
            sections = CASE WHEN $9::text IS NOT NULL THEN $9::jsonb ELSE sections END
          WHERE id = $1::uuid
          RETURNING *;
        `, [
          req.params.patternId,
          d.patternName,
          d.testArchetype,
          d.totalMarks,
          d.durationMinutes,
          d.hasNegativeMarking,
          d.negativeMarkingPenalty,
          d.hasViva,
          d.sections ? JSON.stringify(d.sections) : null,
        ]);
        if (!updateRes.rowCount) return reply.status(404).send({ error: 'Pattern not found' });
        return { success: true, pattern: updateRes.rows[0] };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // Delete Admission Test Pattern
  app.delete<{ Params: { patternId: string } }>(
    '/api/v1/management/academic/patterns/:patternId',
    { preHandler: [requireStaffRole(['super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      try {
        await db.query(`DELETE FROM public.admission_test_patterns WHERE id = $1::uuid`, [req.params.patternId]);
        return { success: true };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // Create Program for a University
  app.post<{ Params: { id: string } }>(
    '/api/v1/management/academic/universities/:id/programs',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const schema = z.object({
        name: z.string().trim().min(2).max(200),
        degreeType: z.string().trim().max(50).default('bachelor'),
        trackCategory: z.string().trim().max(50).default('engineering'),
        totalCredits: z.number().positive().max(500).optional().nullable(),
        durationYears: z.number().positive().max(10).optional().nullable(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      const d = parsed.data;
      const slug = d.name.toLowerCase().replace(/[^a-z0-9]/g, '-');

      try {
        const ins = await db.query(`
          INSERT INTO public.programs (
            university_id, slug, name, degree_type, track_category, total_credits, duration_years, is_active
          ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, true)
          RETURNING *;
        `, [req.params.id, slug, d.name, d.degreeType, d.trackCategory, d.totalCredits || null, d.durationYears || null]);
        return { success: true, program: ins.rows[0] };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // Update Program
  app.put<{ Params: { programId: string } }>(
    '/api/v1/management/academic/programs/:programId',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const schema = z.object({
        name: z.string().trim().min(2).max(200).optional(),
        degreeType: z.string().trim().max(50).optional(),
        trackCategory: z.string().trim().max(50).optional(),
        totalCredits: z.number().positive().max(500).optional().nullable(),
        durationYears: z.number().positive().max(10).optional().nullable(),
        isActive: z.boolean().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      const d = parsed.data;

      try {
        const updateRes = await db.query(`
          UPDATE public.programs
          SET 
            name = COALESCE($2, name),
            degree_type = COALESCE($3, degree_type),
            track_category = COALESCE($4, track_category),
            total_credits = COALESCE($5, total_credits),
            duration_years = COALESCE($6, duration_years),
            is_active = COALESCE($7, is_active)
          WHERE id = $1::uuid
          RETURNING *;
        `, [req.params.programId, d.name, d.degreeType, d.trackCategory, d.totalCredits, d.durationYears, d.isActive]);
        if (!updateRes.rowCount) return reply.status(404).send({ error: 'Program not found' });
        return { success: true, program: updateRes.rows[0] };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // Delete Program
  app.delete<{ Params: { programId: string } }>(
    '/api/v1/management/academic/programs/:programId',
    { preHandler: [requireStaffRole(['super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      try {
        await db.query(`DELETE FROM public.programs WHERE id = $1::uuid`, [req.params.programId]);
        return { success: true };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // =========================================================================
  // 2. UNIVERSITY TARGET LIST SUMMARY
  // =========================================================================
  app.get(
    '/api/v1/management/academic/targets/summary',
    { preHandler: [requireStaffRole(['setter', 'moderator', 'scheduler', 'super_admin'])] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      try {
        const result = await db.query(`
          WITH target_counts AS (
            SELECT 
              jsonb_array_elements_text(COALESCE(u.target_universities, '[]'::jsonb)) AS uni_target,
              COUNT(*)::int AS candidate_count
            FROM public.users u
            WHERE u.target_universities IS NOT NULL AND jsonb_array_length(COALESCE(u.target_universities, '[]'::jsonb)) > 0
            GROUP BY uni_target
          )
          SELECT 
            tc.uni_target AS "targetIdentifier",
            tc.candidate_count AS "candidateCount",
            uni.id AS "universityId",
            uni.full_name AS "universityFullName",
            uni.short_name AS "universityShortName",
            uni.code AS "universityCode",
            uni.logo_url AS "logoUrl",
            uni.exam_format_type AS "examFormatType"
          FROM target_counts tc
          LEFT JOIN public.universities uni ON 
            LOWER(uni.code) = LOWER(tc.uni_target) 
            OR LOWER(uni.short_name) = LOWER(tc.uni_target)
            OR LOWER(uni.slug) = LOWER(tc.uni_target)
            OR LOWER(uni.full_name) ILIKE '%' || LOWER(tc.uni_target) || '%'
          ORDER BY tc.candidate_count DESC;
        `);
        return { success: true, targets: result.rows };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // =========================================================================
  // 3. INSTITUTIONS (COLLEGES & SCHOOLS)
  // =========================================================================
  app.get(
    '/api/v1/management/academic/institutions',
    { preHandler: [requireStaffRole(['setter', 'moderator', 'scheduler', 'super_admin'])] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const query = (req.query as any) || {};
      const search = String(query.search || '').trim();
      const type = String(query.type || 'all'); // 'college', 'school', 'all'
      const limit = Math.min(100, Math.max(1, Number(query.limit) || 40));
      const offset = Math.max(0, Number(query.offset) || 0);

      try {
        let whereClauses: string[] = ['i.is_active = true'];
        let params: any[] = [];

        if (search) {
          params.push(`%${search}%`);
          whereClauses.push(`(i.name_en ILIKE $${params.length} OR i.name_bn ILIKE $${params.length} OR i.eiin ILIKE $${params.length})`);
        }

        if (type === 'college') {
          whereClauses.push('i.is_college = true');
        } else if (type === 'school') {
          whereClauses.push('i.is_school = true');
        }

        const countQuery = `SELECT count(*)::int AS total FROM public.institutions i WHERE ${whereClauses.join(' AND ')}`;
        const dataQuery = `
          SELECT 
            i.id,
            i.eiin,
            i.name_en AS "nameEn",
            i.name_bn AS "nameBn",
            i.is_school AS "isSchool",
            i.is_college AS "isCollege",
            i.is_madrasa AS "isMadrasa",
            i.is_technical AS "isTechnical",
            i.is_active AS "isActive",
            i.created_at AS "createdAt"
          FROM public.institutions i
          WHERE ${whereClauses.join(' AND ')}
          ORDER BY i.name_en ASC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;

        const [countRes, dataRes] = await Promise.all([
          db.query(countQuery, params),
          db.query(dataQuery, [...params, limit, offset]),
        ]);

        return {
          success: true,
          total: countRes.rows[0]?.total || 0,
          limit,
          offset,
          institutions: dataRes.rows,
        };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // Create Institution
  app.post(
    '/api/v1/management/academic/institutions',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const schema = z.object({
        eiin: z.string().trim().max(20).optional().nullable(),
        nameEn: z.string().trim().min(3).max(255),
        nameBn: z.string().trim().max(255).optional().nullable(),
        isSchool: z.boolean().default(false),
        isCollege: z.boolean().default(true),
        isMadrasa: z.boolean().default(false),
        isTechnical: z.boolean().default(false),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      const d = parsed.data;

      try {
        const ins = await db.query(`
          INSERT INTO public.institutions (
            eiin, name_en, name_bn, is_school, is_college, is_madrasa, is_technical, is_active
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)
          RETURNING *;
        `, [d.eiin, d.nameEn, d.nameBn, d.isSchool, d.isCollege, d.isMadrasa, d.isTechnical]);
        return { success: true, institution: ins.rows[0] };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // Update Institution
  app.put<{ Params: { id: string } }>(
    '/api/v1/management/academic/institutions/:id',
    { preHandler: [requireStaffRole(['scheduler', 'super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const schema = z.object({
        eiin: z.string().trim().max(20).optional().nullable(),
        nameEn: z.string().trim().min(3).max(255).optional(),
        nameBn: z.string().trim().max(255).optional().nullable(),
        isSchool: z.boolean().optional(),
        isCollege: z.boolean().optional(),
        isMadrasa: z.boolean().optional(),
        isTechnical: z.boolean().optional(),
        isActive: z.boolean().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      const d = parsed.data;

      try {
        const updateRes = await db.query(`
          UPDATE public.institutions
          SET 
            eiin = COALESCE($2, eiin),
            name_en = COALESCE($3, name_en),
            name_bn = COALESCE($4, name_bn),
            is_school = COALESCE($5, is_school),
            is_college = COALESCE($6, is_college),
            is_madrasa = COALESCE($7, is_madrasa),
            is_technical = COALESCE($8, is_technical),
            is_active = COALESCE($9, is_active),
            updated_at = NOW()
          WHERE id = $1::uuid
          RETURNING *;
        `, [req.params.id, d.eiin, d.nameEn, d.nameBn, d.isSchool, d.isCollege, d.isMadrasa, d.isTechnical, d.isActive]);
        if (!updateRes.rowCount) return reply.status(404).send({ error: 'Institution not found' });
        return { success: true, institution: updateRes.rows[0] };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // =========================================================================
  // 4. LEARNERS DIRECTORY & FULL HISTORY DRILLDOWN
  // =========================================================================

  // List all learners with search & filters
  app.get(
    '/api/v1/management/learners',
    { preHandler: [requireStaffRole(['support', 'setter', 'moderator', 'scheduler', 'super_admin'])] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const query = (req.query as any) || {};
      const search = String(query.search || '').trim();
      const medium = String(query.medium || 'all');
      const limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
      const offset = Math.max(0, Number(query.offset) || 0);

      try {
        let whereClauses: string[] = ['1=1'];
        let params: any[] = [];

        if (search) {
          params.push(`%${search}%`);
          whereClauses.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length} OR u.institution_name ILIKE $${params.length} OR u.id::text ILIKE $${params.length})`);
        }

        if (medium !== 'all') {
          params.push(medium);
          whereClauses.push(`u.medium = $${params.length}`);
        }

        const countQuery = `SELECT count(*)::int AS total FROM public.users u WHERE ${whereClauses.join(' AND ')}`;
        const dataQuery = `
          SELECT 
            u.id,
            u.full_name AS "fullName",
            u.email,
            u.phone,
            u.medium,
            u.english_curriculum AS "englishCurriculum",
            u.nctb_version AS "nctbVersion",
            u.academic_batch AS "academicBatch",
            u.institution_name AS "institutionName",
            u.target_universities AS "targetUniversities",
            u.target_disciplines AS "targetDisciplines",
            u.track,
            u.total_xp AS "totalXp",
            u.coins,
            u.streak_days AS "streakDays",
            u.is_premium AS "isPremium",
            u.created_at AS "createdAt",
            u.last_login_at AS "lastLoginAt",
            (SELECT COUNT(*)::int FROM public.exam_submissions es WHERE es.user_id = u.id) AS "submissionCount",
            (SELECT COUNT(*)::int FROM public.user_practice_progress p WHERE p.user_id = u.id) AS "topicsTracked"
          FROM public.users u
          WHERE ${whereClauses.join(' AND ')}
          ORDER BY u.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;

        const [countRes, dataRes] = await Promise.all([
          db.query(countQuery, params),
          db.query(dataQuery, [...params, limit, offset]),
        ]);

        return {
          success: true,
          total: countRes.rows[0]?.total || 0,
          limit,
          offset,
          learners: dataRes.rows,
        };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // Get single learner full profile & whole history
  app.get<{ Params: { id: string } }>(
    '/api/v1/management/learners/:id/history',
    { preHandler: [requireStaffRole(['support', 'setter', 'moderator', 'scheduler', 'super_admin'])] },
    async (req, reply) => {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
      const learnerId = req.params.id;

      try {
        const userRes = await db.query(`
          SELECT 
            u.id, u.full_name AS "fullName", u.email, u.phone, u.medium,
            u.english_curriculum AS "englishCurriculum", u.nctb_version AS "nctbVersion",
            u.academic_batch AS "academicBatch", u.institution_name AS "institutionName",
            u.institution_eiin AS "institutionEiin", u.target_universities AS "targetUniversities",
            u.target_disciplines AS "targetDisciplines", u.track, u.total_xp AS "totalXp",
            u.coins, u.current_league AS "currentLeague", u.streak_days AS "streakDays",
            u.is_premium AS "isPremium", u.created_at AS "createdAt", u.last_login_at AS "lastLoginAt",
            u.ssc_group AS "sscGroup", u.ssc_year AS "sscYear", u.ssc_gpa AS "sscGpa",
            u.ssc_institution AS "sscInstitution", u.hsc_group AS "hscGroup",
            u.hsc_batch AS "hscBatch", u.hsc_gpa AS "hscGpa", u.hsc_institution AS "hscInstitution",
            u.o_level_board AS "oLevelBoard", u.o_level_year AS "oLevelYear",
            u.o_level_grades AS "oLevelGrades", u.o_level_school AS "oLevelSchool",
            u.a_level_board AS "aLevelBoard", u.a_level_batch AS "aLevelBatch",
            u.a_level_grades AS "aLevelGrades", u.a_level_college AS "aLevelCollege"
          FROM public.users u WHERE u.id = $1::uuid LIMIT 1
        `, [learnerId]);

        if (!userRes.rowCount) return reply.status(404).send({ error: 'Learner account not found.' });
        const user = userRes.rows[0];

        // All exam submissions (Live and Practice)
        const submissionsRes = await db.query(`
          SELECT 
            es.id,
            es.exam_id AS "examId",
            e.title AS "examTitle",
            e.track AS "examTrack",
            e.total_marks AS "totalMarks",
            es.score,
            es.correct_count AS "correctCount",
            es.wrong_count AS "wrongCount",
            es.unanswered_count AS "unansweredCount",
            es.time_taken_seconds AS "timeTakenSeconds",
            es.is_practice AS "isPractice",
            es.submitted_at AS "submittedAt"
          FROM public.exam_submissions es
          LEFT JOIN public.exams e ON e.id = es.exam_id
          WHERE es.user_id = $1::uuid
          ORDER BY es.submitted_at DESC;
        `, [learnerId]);

        // Practice progress by topic
        const practiceRes = await db.query(`
          SELECT 
            p.topic_id AS "topicId",
            t.name AS "topicName",
            s.name AS "subjectName",
            p.accuracy_rate AS "accuracyRate",
            p.total_attempts AS "totalAttempts",
            p.correct_count AS "correctCount",
            p.wrong_count AS "wrongCount",
            p.last_reviewed_at AS "lastReviewedAt"
          FROM public.user_practice_progress p
          LEFT JOIN public.academic_topics t ON t.id = p.topic_id
          LEFT JOIN public.academic_subjects s ON s.id = t.subject_id
          WHERE p.user_id = $1::uuid
          ORDER BY p.last_reviewed_at DESC LIMIT 50;
        `, [learnerId]);

        // Mistake vault records
        const mistakesRes = await db.query(`
          SELECT 
            m.id,
            m.question_id AS "questionId",
            q.stem_primary AS "questionText",
            m.mistake_count AS "mistakeCount",
            m.is_mastered AS "isMastered",
            m.last_attempted_at AS "lastAttemptedAt"
          FROM public.mistake_vault m
          LEFT JOIN public.questions q ON q.id = m.question_id
          WHERE m.user_id = $1::uuid
          ORDER BY m.last_attempted_at DESC LIMIT 30;
        `, [learnerId]);

        return {
          success: true,
          learner: user,
          submissions: submissionsRes.rows,
          practiceProgress: practiceRes.rows,
          mistakes: mistakesRes.rows,
        };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );
};
