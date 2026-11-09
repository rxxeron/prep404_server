import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { RedisService } from '../redis/redis.service';
import { sendInternalError } from '../services/http_errors';
import type { ExamRouteOptions } from './exam.routes';

/** Exam listings, per-university breakdowns, question delivery and latest daily-test metadata. */
export const examCatalogRoutes: FastifyPluginAsync<ExamRouteOptions> = async (
  app: FastifyInstance,
  opts: ExamRouteOptions,
) => {
  const { db, redis } = opts;

  // 1. Live Exams Catalog from PostgreSQL with Dynamic Filters
  app.get<{
    Querystring: {
      universityCode?: string;
      track?: string;
      examType?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/v1/exam/live', async (req, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    try {
      const { universityCode, track, examType, search, limit = '100', offset = '0' } = req.query;
      const targetUni = (universityCode || track || '').trim().toUpperCase();

      let query = `
        SELECT 
          e.id,
          e.title,
          e.track,
          e.exam_type AS "examType",
          ROUND(e.duration_seconds / 60) AS "durationMinutes",
          e.total_marks AS "totalMarks",
          COALESCE(e.negative_mark_per_question, 0.25) AS "negativeMarking",
          e.starts_at AS "startTime",
          e.ends_at AS "endTime",
          (e.is_active = true
            AND (e.starts_at IS NULL OR e.starts_at <= now())
            AND (e.ends_at IS NULL OR e.ends_at > now())) AS "isLiveNow",
          CASE
            WHEN e.starts_at IS NOT NULL AND e.starts_at > now() THEN 'scheduled'
            WHEN e.ends_at IS NOT NULL AND e.ends_at <= now() THEN 'completed'
            ELSE 'live'
          END AS "lifecycleStatus",
          u.code AS "universityCode",
          u.full_name AS "universityName",
          (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS "totalQuestions"
        FROM exams e
        LEFT JOIN universities u ON u.id = e.target_university_id
        WHERE e.is_active = true
      `;
      const params: any[] = [];

      if (targetUni && targetUni !== 'ALL') {
        params.push(targetUni);
        query += ` AND (UPPER(e.track) = $${params.length} OR UPPER(u.code) = $${params.length})`;
      }

      if (examType && examType !== 'all') {
        params.push(examType);
        query += ` AND e.exam_type = $${params.length}`;
      }

      if (search && search.trim().length > 0) {
        params.push(`%${search.trim()}%`);
        query += ` AND e.title ILIKE $${params.length}`;
      }

      query += ` ORDER BY e.created_at DESC, e.starts_at DESC`;

      const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
      const offsetNum = Math.max(0, parseInt(offset, 10));

      params.push(limitNum);
      query += ` LIMIT $${params.length}`;

      params.push(offsetNum);
      query += ` OFFSET $${params.length}`;

      const res = await db.query(query, params);

      return {
        success: true,
        count: res.rows.length,
        exams: res.rows,
      };
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // 1b. University Specific Exam Breakdown (Model Tests, Past Papers, Section Exams)
  app.get<{ Params: { code: string } }>('/api/v1/exam/university/:code/breakdown', async (req, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    try {
      const uniCode = req.params.code.trim().toUpperCase();

      // University info
      const uniRes = await db.query(`
        SELECT id, code, full_name AS "fullName", short_name AS "shortName", logo_url AS "logoUrl",
               campus_location AS "campusLocation", exam_pattern_summary AS "examPatternSummary"
        FROM universities
        WHERE UPPER(code) = $1 OR UPPER(slug) = $1
        LIMIT 1;
      `, [uniCode]);

      if (uniRes.rows.length === 0) {
        return reply.status(404).send({ error: `University '${uniCode}' not found` });
      }
      const university = uniRes.rows[0];

      // All exams for this university
      const examsRes = await db.query(`
        SELECT 
          e.id,
          e.title,
          e.track,
          e.exam_type AS "examType",
          ROUND(e.duration_seconds / 60) AS "durationMinutes",
          e.total_marks AS "totalMarks",
          COALESCE(e.negative_mark_per_question, 0.25) AS "negativeMarking",
          e.starts_at AS "startTime",
          e.ends_at AS "endTime",
          CASE
            WHEN e.starts_at IS NOT NULL AND e.starts_at > now() THEN 'scheduled'
            WHEN e.ends_at IS NOT NULL AND e.ends_at <= now() THEN 'completed'
            ELSE 'live'
          END AS status,
          (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS "totalQuestions"
        FROM exams e
        WHERE (e.target_university_id = $1::uuid OR UPPER(e.track) = $2) AND e.is_active = true
        ORDER BY e.created_at ASC, e.title ASC;
      `, [university.id, uniCode]);

      const modelTests: any[] = [];
      const pastPapers: any[] = [];
      const sectionExams: any[] = [];

      for (const row of examsRes.rows) {
        const item = {
          id: row.id,
          slug: row.id,
          title: row.title,
          track: row.track,
          examType: row.examType,
          durationMinutes: row.durationMinutes,
          totalMarks: row.totalMarks,
          negativeMarking: row.negativeMarking,
          totalQuestions: row.totalQuestions,
          startTime: row.startTime,
          endTime: row.endTime,
        };

        if (row.examType === 'model_test' || row.examType === 'daily_live') {
          modelTests.push(item);
        } else if (row.examType === 'uni_exam') {
          pastPapers.push(item);
        } else if (row.examType === 'section_exam') {
          sectionExams.push(item);
        }
      }

      return {
        success: true,
        university,
        stats: {
          totalExams: examsRes.rows.length,
          modelTestsCount: modelTests.length,
          pastPapersCount: pastPapers.length,
          sectionExamsCount: sectionExams.length,
        },
        modelTests,
        pastPapers,
        sectionExams,
      };
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // 2. Exam Question Fetch by Exam ID from PostgreSQL (Anti-Cheat Secure Delivery)
  app.get<{ Params: { id: string } }>(
    '/api/v1/exam/:id/questions',
    async (req, reply: FastifyReply) => {
      const { id } = req.params;
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

      try {
        const exam = await db.query(`SELECT id FROM public.exams
          WHERE id=$1::uuid AND is_active=true
            AND (starts_at IS NULL OR starts_at<=now())
            AND (ends_at IS NULL OR ends_at>now())`, [id]);
        if (!exam.rowCount) return reply.status(404).send({ error: 'Exam not found' });

        const res = await db.query(`
          SELECT 
            eq.question_order AS "order",
            q.id,
            q.stem_primary AS "questionText",
            (q.stem_primary LIKE '%$%' OR q.stem_primary LIKE '%\\%') AS "hasMath",
             q.options,
            q.difficulty_rating AS "difficultyRating"
          FROM exam_questions eq
          JOIN questions q ON q.id = eq.question_id
          WHERE eq.exam_id = $1::uuid AND q.is_active = true AND q.review_status='approved'
          ORDER BY eq.question_order ASC;
        `, [id]);

        const formatted = res.rows.map((row) => {
          const rawOptions = Array.isArray(row.options) ? row.options : [];
          let correctOption = 'A';
          const options = rawOptions.map((opt: any, idx: number) => {
            const key = opt.key_original || String.fromCharCode(65 + idx);
            if (opt.is_correct) correctOption = key;
            return { id: key, text: opt.text || '' };
          });

          return {
            id: row.id,
            questionText: row.questionText,
            hasMath: row.hasMath,
            options,
            difficultyRating: parseFloat(row.difficultyRating || '1.0'),
          };
        });

           return {
          success: true,
          examId: id,
          count: formatted.length,
          questions: formatted,
        };
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }
  );

  // 5. Latest Daily Model Test Metadata
  app.get('/api/v1/exams/daily/latest', async (_req, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    try {
      const res = await db.query(`
        SELECT 
          e.id,
          e.title,
          ROUND(e.duration_seconds / 60) AS "durationMinutes",
          e.total_marks AS "totalMarks",
          COALESCE(e.negative_mark_per_question, 0.25) AS "negativeMark",
          (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS "questionCount"
        FROM exams e
        WHERE e.is_active = true
          AND (e.starts_at IS NULL OR e.starts_at <= now())
          AND (e.ends_at IS NULL OR e.ends_at > now())
        ORDER BY e.created_at DESC
        LIMIT 1;
      `);

      if (res.rows.length === 0) {
        return reply.status(404).send({ error: 'No active exams found in database' });
      }

      const exam = res.rows[0];
      return {
        success: true,
        exam: {
          slug: exam.id,
          title: exam.title,
          shareableUrl: `https://prep404.com/m/${exam.id}`,
          durationMinutes: exam.durationMinutes,
          totalMarks: exam.totalMarks,
          negativeMark: exam.negativeMark,
          questionCount: exam.questionCount,
        },
      };
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });
};
