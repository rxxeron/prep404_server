import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Pool } from 'pg';
import crypto from 'crypto';
import { RedisService } from '../redis/redis.service';
import { requireStaffRole } from '../middleware/rbac.middleware';
import { sendInternalError } from '../services/http_errors';

export const blueprintManagementRoutes: FastifyPluginAsync<{ db: Pool; redis: RedisService }> = async (
  app: FastifyInstance,
  opts: { db: Pool; redis: RedisService }
) => {
  const { db, redis } = opts;

  const deployableQuestionPredicate = (alias: string) =>
    `${alias}.is_active = true AND ${alias}.review_status = 'approved' AND ${alias}.topic_id IS NOT NULL AND length(trim(COALESCE(${alias}.stem_primary,''))) >= 5 AND length(trim(COALESCE(${alias}.solution_markdown,''))) >= 3 AND CASE WHEN jsonb_typeof(${alias}.options)='array' THEN jsonb_array_length(${alias}.options) >= 2 AND (SELECT count(*) FROM jsonb_array_elements(${alias}.options) AS option_item WHERE COALESCE(option_item->>'is_correct','false')='true') = 1 ELSE false END`;

  const buildShareSnippet = (title: string, slug: string, duration: number, marks: number, neg: number) => {
    return {
      whatsapp: `🏆 *Prep404 Daily Live Model Test is LIVE!*\n📚 *Test*: ${title}\n⏱️ *Duration*: ${duration} Mins | 🎯 *Total Marks*: ${marks} (-${neg})\n📊 *Live Merit Ranking*: Instant national percentiles!\n👉 *Take Test Now*: https://prep404.com/m/${slug}\n_Powered by Prep404_`,
      telegram: `🔥 **Prep404 Live Model Test**: ${title}\n⏱ Duration: ${duration} mins | 🎯 Marks: ${marks} (-${neg})\n🔗 Join: https://prep404.com/m/${slug}`,
    };
  };

  // =========================================================================
  // 1. UNIVERSITY BLUEPRINTS DIRECTORY
  // =========================================================================
  app.get('/api/v1/management/blueprints',
    { preHandler: [requireStaffRole(['setter', 'moderator', 'scheduler', 'super_admin'])] }, async (_req, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    try {
      const res = await db.query(`
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

      return {
        success: true,
        count: res.rows.length,
        blueprints: res.rows,
      };
    } catch (err: any) {
      console.error('[Blueprints Error]', err);
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 2. DYNAMIC EXAM GENERATOR FROM BLUEPRINT (Section Quotas + Random Pooling)
  // =========================================================================
  const GenerateDynamicExamSchema = z.object({
    blueprintId: z.string().uuid().optional(),
    universityCode: z.string().trim().min(2).max(50).default('nsu'),
    title: z.string().trim().min(5).max(160),
    durationMinutes: z.number().int().min(1).max(300).default(60),
    totalMarks: z.number().positive().max(2000).default(100),
    negativeMark: z.number().min(0).max(100).default(0.25),
    sectionQuotas: z.array(z.object({
      subjectSlug: z.string().trim().min(1).max(80),
      count: z.number().int().min(1).max(200),
      name: z.string().trim().max(80).optional(),
    })).min(1).max(20),
    scrambleOptions: z.boolean().default(true),
  }).superRefine((value, context) => {
    if (value.negativeMark > value.totalMarks) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['negativeMark'], message: 'Negative marking cannot exceed total marks.' });
    }
    const requestedCount = value.sectionQuotas.reduce((sum, quota) => sum + quota.count, 0);
    if (requestedCount > 200) context.addIssue({ code: z.ZodIssueCode.custom, path: ['sectionQuotas'], message: 'An exam can contain at most 200 questions.' });
  });

  app.post(
    '/api/v1/management/blueprints/generate-exam',
    { preHandler: [requireStaffRole(['scheduler', 'setter', 'super_admin'])] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parse = GenerateDynamicExamSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ error: parse.error.errors[0].message });
      }

      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

      const { universityCode, title, durationMinutes, totalMarks, negativeMark, sectionQuotas } = parse.data;
      const requestedQuestionCount = sectionQuotas.reduce((sum, quota) => sum + quota.count, 0);

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const uniRes = await client.query(`
          SELECT id, code, full_name FROM universities 
          WHERE LOWER(code) = LOWER($1) OR LOWER(slug) = LOWER($1) 
          LIMIT 1;
        `, [universityCode]);
        const uniId = uniRes.rows.length > 0 ? uniRes.rows[0].id : null;

        const examRes = await client.query(`
          INSERT INTO exams (
            title, track, exam_type, duration_seconds, total_marks,
            negative_mark_per_question, starts_at, ends_at, is_active, target_university_id
          ) VALUES ($1, 'private_uni', 'model_test', $2, $3, $4, NOW(), NOW() + INTERVAL '30 days', true, $5)
          RETURNING *;
        `, [title, durationMinutes * 60, totalMarks, negativeMark, uniId]);

        const examId = examRes.rows[0].id;
        const selectedQuestions: any[] = [];
        const selectedQuestionIds = new Set<string>();
        let orderIdx = 1;

        const slugAliases: Record<string, string> = {
          'eng': 'english',
          'english': 'english',
          'english-language': 'english',
          'quant': 'general_mathematics',
          'math': 'general_mathematics',
          'general-mathematics': 'general_mathematics',
          'gen_math': 'general_mathematics',
          'higher-math': 'higher_mathematics',
          'high_math': 'higher_mathematics',
          'higher_mathematics': 'higher_mathematics',
          'physics': 'physics',
          'phy': 'physics',
          'chemistry': 'chemistry',
          'chem': 'chemistry',
          'biology': 'biology',
          'bio': 'biology',
        };

        for (const quota of sectionQuotas) {
          const targetSlug = slugAliases[quota.subjectSlug.toLowerCase()] || quota.subjectSlug.toLowerCase();
          
          const seed1 = crypto.randomUUID();
          const qRes = await client.query(`
            SELECT q.id, q.stem_primary AS "questionText", q.difficulty_rating AS "difficulty",
                   s.name AS "subjectName", s.slug AS "subjectSlug"
            FROM questions q
            JOIN academic_subjects s ON s.id = q.subject_id
            WHERE ${deployableQuestionPredicate('q')} AND (s.slug = $1 OR s.slug ILIKE $2)
              AND NOT (q.id = ANY($4::uuid[]))
            ORDER BY (q.id >= $5::uuid) DESC, q.id ASC
            LIMIT $3;
          `, [targetSlug, `%${targetSlug}%`, quota.count, [...selectedQuestionIds], seed1]);

          let questionsForSection = qRes.rows;
          if (questionsForSection.length < quota.count) {
            const needed = quota.count - questionsForSection.length;
            const excludedIds = [...selectedQuestionIds, ...questionsForSection.map((x: any) => x.id)];
            const seed2 = crypto.randomUUID();
            const fallbackRes = await client.query(`
              SELECT q.id, q.stem_primary AS "questionText", q.difficulty_rating AS "difficulty",
                     s.name AS "subjectName", s.slug AS "subjectSlug"
              FROM questions q
              LEFT JOIN academic_subjects s ON s.id = q.subject_id
              WHERE ${deployableQuestionPredicate('q')} AND NOT (q.id = ANY($2::uuid[]))
              ORDER BY (q.id >= $3::uuid) DESC, q.id ASC
              LIMIT $1;
            `, [needed, excludedIds, seed2]);
            questionsForSection = [...questionsForSection, ...fallbackRes.rows];
          }

          if (questionsForSection.length < quota.count) {
            const shortage = new Error(`Only ${questionsForSection.length} of ${quota.count} requested questions are available for ${quota.name || quota.subjectSlug}.`);
            (shortage as Error & { code?: string }).code = 'INSUFFICIENT_QUESTIONS';
            throw shortage;
          }

          for (const q of questionsForSection) {
            await client.query(`
              INSERT INTO exam_questions (exam_id, question_id, question_order)
              VALUES ($1::uuid, $2::uuid, $3)
              ON CONFLICT DO NOTHING;
            `, [examId, q.id, orderIdx++]);
            selectedQuestionIds.add(q.id);

            selectedQuestions.push({
              order: orderIdx - 1,
              id: q.id,
              subject: q.subjectName || targetSlug,
              difficulty: q.difficulty || 1.2,
              snippet: (q.questionText || '').substring(0, 80) + '...',
            });
          }
        }

        const shareableUrl = `https://prep404.com/m/${examId}`;
        const snippets = buildShareSnippet(title, examId, durationMinutes, totalMarks, negativeMark);

        if (selectedQuestions.length !== requestedQuestionCount) {
          throw new Error('The assembled exam did not match the requested question count.');
        }
        const actor = (req as any).staffUser;
        await client.query(`INSERT INTO public.staff_audit_logs
          (actor_email, actor_role, action, entity_type, entity_id, metadata)
          VALUES ($1,$2,'exam.generated','exam',$3,$4::jsonb)`, [actor.email, actor.role, examId, JSON.stringify({ title, universityCode, requestedQuestionCount, durationMinutes, totalMarks, negativeMark })]);
        await client.query('COMMIT');

        return {
          success: true,
          message: `Successfully assembled dynamic exam with ${selectedQuestions.length} questions!`,
          examId,
          title,
          universityCode,
          durationMinutes,
          totalMarks,
          negativeMark,
          totalQuestionsAssembled: selectedQuestions.length,
          shareableUrl,
          socialSnippets: snippets,
          sampleQuestions: selectedQuestions.slice(0, 8),
        };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err.code === 'INSUFFICIENT_QUESTIONS') return reply.status(409).send({ error: err.message, code: err.code });
        req.log.error({ err }, 'Atomic blueprint exam generation failed');
        return sendInternalError(reply, err);
      } finally { client.release(); }
    }
  );

  // =========================================================================
  // 3. ADMIN TODAY'S DAILY TEST SETTER (INSTANT WARM CACHE SNAPSHOT)
  // Anti-Cheat: Sanitizes options and omits explanations from public pre-test cache
  // =========================================================================
  const SetDailyTestSchema = z.object({
    universityCode: z.string().trim().min(2).max(50).default('nsu'),
    title: z.string().trim().min(5).max(160),
    durationMinutes: z.number().int().min(1).max(300).default(30),
    totalMarks: z.number().positive().max(2000).default(50),
    negativeMark: z.number().min(0).max(100).default(0.25),
    questionCount: z.number().int().min(1).max(100).default(20),
  }).refine((value) => value.negativeMark <= value.totalMarks, {
    path: ['negativeMark'],
    message: 'Negative marking cannot exceed total marks.',
  });

  app.post(
    '/api/v1/management/daily-test/set',
    { preHandler: [requireStaffRole(['scheduler', 'setter', 'super_admin'])] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parse = SetDailyTestSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ error: parse.error.errors[0].message });
      }

      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

      const { universityCode, title, durationMinutes, totalMarks, negativeMark, questionCount } = parse.data;

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const uniRes = await client.query(`
          SELECT id, code, full_name, logo_url FROM universities 
          WHERE LOWER(code) = LOWER($1) OR LOWER(slug) = LOWER($1) 
          LIMIT 1;
        `, [universityCode]);

        const uni = uniRes.rows.length > 0 ? uniRes.rows[0] : null;

        const examRes = await client.query(`
          INSERT INTO exams (
            title, track, exam_type, duration_seconds, total_marks,
            negative_mark_per_question, starts_at, ends_at, is_active, target_university_id
          ) VALUES ($1, 'private_uni', 'daily_live', $2, $3, $4, NOW(), NOW() + INTERVAL '2 days', true, $5)
          RETURNING *;
        `, [title, durationMinutes * 60, totalMarks, negativeMark, uni ? uni.id : null]);

        const examId = examRes.rows[0].id;

        const seed3 = crypto.randomUUID();
        const qRes = await client.query(`
          SELECT q.id, q.stem_primary AS "questionText", (q.stem_primary LIKE '%$%' OR q.stem_primary LIKE '%\\%') AS "hasMath",
                 q.options, q.difficulty_rating AS "difficultyRating", s.name AS "subjectName"
          FROM questions q
          LEFT JOIN academic_subjects s ON s.id = q.subject_id
          WHERE ${deployableQuestionPredicate('q')}
            AND q.item_type = 'mcq_standalone'
            AND jsonb_array_length(q.options) >= 2
          ORDER BY (q.id >= $2::uuid) DESC, q.id ASC
          LIMIT $1;
        `, [questionCount, seed3]);

        if (qRes.rows.length < questionCount) {
          const shortage = new Error(`Only ${qRes.rows.length} of ${questionCount} requested exam-ready questions are available.`);
          (shortage as Error & { code?: string }).code = 'INSUFFICIENT_QUESTIONS';
          throw shortage;
        }

        for (let i = 0; i < qRes.rows.length; i++) {
          await client.query(`
            INSERT INTO exam_questions (exam_id, question_id, question_order)
            VALUES ($1::uuid, $2::uuid, $3)
            ON CONFLICT DO NOTHING;
          `, [examId, qRes.rows[i].id, i + 1]);
        }

        const sanitizedQuestions = qRes.rows.map((row, idx) => {
          const rawOpts = Array.isArray(row.options) ? row.options : [];
          const options = rawOpts.map((opt: any, i: number) => ({
            id: opt.key_original || opt.id || String.fromCharCode(65 + i),
            text: opt.text || '',
          }));

          return {
            id: row.id,
            order: idx + 1,
            subject: row.subjectName || 'General',
            questionText: row.questionText,
            hasMath: row.hasMath,
            options,
            difficultyRating: parseFloat(row.difficultyRating || '1.0'),
          };
        });

        const compiledPayload = {
          success: true,
          date: new Date().toISOString().split('T')[0],
          examId,
          title,
          track: 'private_uni',
          universityCode: uni ? uni.code : universityCode.toUpperCase(),
          universityName: uni ? uni.full_name : 'Private University',
          universityLogo: uni ? uni.logo_url : '',
          durationMinutes,
          totalMarks,
          negativeMark,
          totalQuestions: sanitizedQuestions.length,
          questions: sanitizedQuestions,
        };

        if (sanitizedQuestions.length !== questionCount) throw new Error('The daily exam question count did not match the request.');
        const actor = (req as any).staffUser;
        await client.query(`INSERT INTO public.staff_audit_logs
          (actor_email, actor_role, action, entity_type, entity_id, metadata)
          VALUES ($1,$2,'exam.daily_test_set','exam',$3,$4::jsonb)`, [actor.email, actor.role, examId, JSON.stringify({ title, universityCode, questionCount, durationMinutes, totalMarks, negativeMark })]);
        await client.query('COMMIT');

        const cacheKeyUni = `daily_test:today:${universityCode.toLowerCase()}`;
        const cacheKeyAll = `daily_test:today:all`;
        try {
          await redis.setSessionKey(cacheKeyUni, JSON.stringify(compiledPayload), 86400);
          await redis.setSessionKey(cacheKeyAll, JSON.stringify(compiledPayload), 86400);
        } catch (err) {
          req.log.warn({ err, examId }, 'Daily exam was saved but the fast snapshot cache could not be warmed');
        }

        return {
          success: true,
          message: `Today's Daily Test set and warmed in cache snapshot! Zero DB queries on student requests.`,
          examId,
          title,
          cachedFor: universityCode.toUpperCase(),
          questionCount: sanitizedQuestions.length,
        };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err.code === 'INSUFFICIENT_QUESTIONS') return reply.status(409).send({ error: err.message, code: err.code });
        req.log.error({ err }, 'Daily exam generation failed');
        return sendInternalError(reply, err);
      } finally { client.release(); }
    }
  );
};
