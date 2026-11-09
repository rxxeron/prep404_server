import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { StreakService } from '../services/streak.service';

interface StreakRouteOptions {
  db: Pool;
}

export async function streakRoutes(fastify: FastifyInstance, options: StreakRouteOptions) {
  const { db } = options;
  const streakService = new StreakService(db);

  /**
   * GET /api/v1/user/streak
   * Retrieves full DB-persisted streak metrics, scoreboard, and chronological timeline
   */
  fastify.get(
    '/api/v1/user/streak',
    async (request: FastifyRequest<{ Querystring: { userId?: string } }>, reply: FastifyReply) => {
      let userId = request.query.userId;

      // Extract user id from token if present and not passed in query
      if (!userId && (request as any).user?.id) {
        userId = (request as any).user.id;
      }

      if (!userId) {
        return reply.status(400).send({
          success: false,
          error: 'User ID is required',
        });
      }

      try {
        const details = await streakService.getStreakDetails(userId);
        return reply.send({
          success: true,
          streak: details,
        });
      } catch (err: any) {
        request.log.error({ err, userId }, 'Failed to fetch user streak details');
        return reply.status(500).send({
          success: false,
          error: 'Internal server error fetching streak details',
        });
      }
    }
  );

  /**
   * POST /api/v1/user/streak/record
   * Manually record study practice activity (e.g. from question bank or mistake vault)
   */
  fastify.post(
    '/api/v1/user/streak/record',
    async (
      request: FastifyRequest<{
        Body: { userId?: string; questionsCount?: number; examsCount?: number };
      }>,
      reply: FastifyReply
    ) => {
      let userId = request.body?.userId;
      if (!userId && (request as any).user?.id) {
        userId = (request as any).user.id;
      }

      if (!userId) {
        return reply.status(400).send({
          success: false,
          error: 'User ID is required',
        });
      }

      const qCount = request.body?.questionsCount ?? 1;
      const examCount = request.body?.examsCount ?? 0;

      try {
        const details = await streakService.recordActivity(userId, qCount, examCount);
        return reply.send({
          success: true,
          streak: details,
        });
      } catch (err: any) {
        request.log.error({ err, userId }, 'Failed to record streak activity');
        return reply.status(500).send({
          success: false,
          error: 'Internal server error recording streak activity',
        });
      }
    }
  );
}
