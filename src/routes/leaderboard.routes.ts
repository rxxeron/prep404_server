import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { RedisService } from '../redis/redis.service';
import { sendInternalError } from '../services/http_errors';
import type { ExamRouteOptions } from './exam.routes';

/** Live per-exam leaderboard (Redis) and the overall national leaderboard (Postgres). */
export const leaderboardRoutes: FastifyPluginAsync<ExamRouteOptions> = async (
  app: FastifyInstance,
  opts: ExamRouteOptions,
) => {
  const { db, redis } = opts;

  // 4. Live Exam Leaderboard from Redis
  app.get('/api/v1/exam/:id/leaderboard', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: string } }>, reply) => {
    const { id: examId } = req.params;
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
    const parsedLimit = Number.parseInt(req.query.limit || '50', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 50;
    try {
      const availability = await db.query(`SELECT 1 FROM public.exams WHERE id=$1::uuid AND is_active=true
        AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())`, [examId]);
      if (!availability.rowCount) return reply.status(404).send({ error: 'Exam not found' });
    } catch (err: any) {
      if (err.code === '22P02') return reply.status(400).send({ error: 'Invalid exam identifier' });
      req.log.error({ err }, 'Exam leaderboard availability check failed');
      return reply.status(503).send({ error: 'Exam leaderboard is temporarily unavailable' });
    }
    const topRankers = await redis.getTopExamRankers(examId, limit);
    return { success: true, examId, topRankers };
  });

  // =========================================================================
  // OVERALL NATIONAL LEADERBOARD (ACROSS ALL UNIVERSITIES)
  // Overall preparation index, model test performance & metrics
  // =========================================================================
  app.get('/api/v1/leaderboard/overall', async (_req, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    try {
      const query = `
        SELECT 
          s.user_id AS "userId",
          COALESCE(s.candidate_name, u.full_name, 'Candidate') AS "name",
          COALESCE(s.candidate_institution, u.institution_name, 'HSC Batch') AS "badge",
          COALESCE(s.university_code, 'NATIONAL') AS "targetUni",
          COUNT(DISTINCT s.exam_id) AS "testsTaken",
          ROUND(AVG(s.score)::numeric, 1) AS "avgScore",
          ROUND(SUM(s.score)::numeric, 1) AS "totalScore",
          ROUND(
            COALESCE(SUM(s.correct_count) * 100.0 / NULLIF(SUM(s.correct_count + s.wrong_count), 0), 0)::numeric, 
            1
          ) AS "accuracyPct",
          ROUND(
            (SUM(s.score) * 1.5 + AVG(s.score) * 5 + COUNT(DISTINCT s.exam_id) * 20)::numeric,
            0
          ) AS "prepRating"
        FROM exam_submissions s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.is_practice = false
        GROUP BY s.user_id, s.candidate_name, u.full_name, s.candidate_institution, u.institution_name, s.university_code
        ORDER BY "prepRating" DESC, "avgScore" DESC, "totalScore" DESC
        LIMIT 25;
      `;
      const res = await db.query(query);

      let rankings = res.rows.map((row, idx) => ({
        rank: idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`,
        name: row.name,
        badge: row.badge,
        targetUni: row.targetUni,
        testsTaken: parseInt(row.testsTaken || '0', 10),
        avgScore: parseFloat(row.avgScore || '0'),
        accuracyPct: parseFloat(row.accuracyPct || '0'),
        prepRating: parseInt(row.prepRating || '0', 10),
        score: `${row.avgScore} avg (${row.accuracyPct}% Acc)`,
      }));

      return {
        success: true,
        rankings,
        available: rankings.length > 0,
        generatedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });
};
