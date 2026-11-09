import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';
import { RedisService } from '../redis/redis.service';
import { examCatalogRoutes } from './exam_catalog.routes';
import { dailyTestRoutes } from './daily_test.routes';
import { leaderboardRoutes } from './leaderboard.routes';
import { examSessionRoutes } from './exam_session.routes';

export type ExamRouteOptions = { db: Pool; redis: RedisService };

/**
 * Learner-facing exam API. Each concern lives in its own plugin:
 * - exam_catalog.routes: listings, breakdowns, question delivery
 * - daily_test.routes: today's test and the archive
 * - leaderboard.routes: per-exam and overall rankings
 * - exam_session.routes: sessions and scored submissions (idempotent)
 */
export const examRoutes: FastifyPluginAsync<ExamRouteOptions> = async (
  app: FastifyInstance,
  opts: ExamRouteOptions,
) => {
  await app.register(examCatalogRoutes, opts);
  await app.register(dailyTestRoutes, opts);
  await app.register(leaderboardRoutes, opts);
  await app.register(examSessionRoutes, opts);
};
