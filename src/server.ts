import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { Pool } from 'pg';
import { startExamSessionRetentionJob } from './services/exam_session_telemetry.service';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { RedisService } from './redis/redis.service';
import { RealBattleGateway } from './battle/real_battle.gateway';

// Modular Route Controllers
import { authRoutes } from './routes/auth.routes';
import { onboardingRoutes } from './routes/onboarding.routes';
import { questionRoutes } from './routes/question.routes';
import { examRoutes } from './routes/exam.routes';
import { publicExamRoutes } from './routes/public_exam.routes';
import { admissionJourneyRoutes } from './routes/admission_journey.routes';
import { managementRoutes } from './routes/management.routes';
import { questionManagementRoutes } from './routes/question_management.routes';
import { academicManagementRoutes } from './routes/academic_management.routes';
import { blueprintManagementRoutes } from './routes/blueprint_management.routes';
import { aiVariantGeneratorRoutes } from './routes/ai_variant_generator.routes';
import { practiceRoutes } from './routes/practice.routes';
import { aiRoutes } from './routes/ai.routes';
import { supportRoutes } from './routes/support.routes';
import { accountRoutes } from './routes/account.routes';
import { battleModerationRoutes } from './routes/battle_moderation.routes';
import { learnerAnalyticsRoutes } from './routes/learner_analytics.routes';
import { streakRoutes } from './routes/streak.routes';
import { notificationRoutes } from './routes/notification.routes';
import { startLearnerAnalyticsRetentionJob } from './services/learner_analytics.service';
import { telemetryRoutes } from './routes/telemetry.routes';
import { TelemetryBatchService } from './services/telemetry_batch.service';
import { sendInternalError } from './services/http_errors';

const envCandidates = [
  path.resolve(process.cwd(), 'server/.env'),
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(process.cwd(), '.env'),
];
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    if (process.env.DATABASE_URL) break;
  }
}

const PORT = parseInt(process.env.PORT || '4040', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/prep404';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured in production');
}
const JWT_SECRET = process.env.JWT_SECRET || 'prep404_local_development_secret';

const POOL_MAX = parseInt(process.env.DATABASE_POOL_MAX || (process.env.NODE_ENV === 'production' ? '25' : '10'), 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.DATABASE_IDLE_TIMEOUT_MS || '15000', 10);
const CONNECTION_TIMEOUT_MS = parseInt(process.env.DATABASE_CONNECTION_TIMEOUT_MS || '10000', 10);
const STATEMENT_TIMEOUT_MS = parseInt(process.env.DATABASE_STATEMENT_TIMEOUT_MS || '10000', 10);

const getSslConfig = () => {
  if (process.env.DATABASE_SSL_CA) {
    return { ca: process.env.DATABASE_SSL_CA, rejectUnauthorized: true };
  }
  if (process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true') {
    return { rejectUnauthorized: true };
  }
  return DATABASE_URL.includes('supabase.com') ? { rejectUnauthorized: false } : undefined;
};

// Initialize PostgreSQL Pool with high-concurrency scaling defaults
export const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: getSslConfig(),
  max: POOL_MAX,
  idleTimeoutMillis: IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  statement_timeout: STATEMENT_TIMEOUT_MS,
});

// Initialize Redis Service
export const redisService = new RedisService(REDIS_URL);

// Build Distributive Fastify App
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    genReqId: (req) => (req.headers['x-request-id'] as string) || crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
    // Behind a load balancer or reverse proxy, set TRUST_PROXY (e.g. "1" for one
    // hop) so req.ip is the learner's address and IP rate limits work per user.
    trustProxy: process.env.TRUST_PROXY
      ? (/^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY === 'true')
      : true,
  });

  // Support empty JSON body gracefully without throwing FST_ERR_CTP_EMPTY_JSON_BODY
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body || (typeof body === 'string' && body.trim().length === 0)) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Errors thrown out of handlers: 4xx keep their message (validation, bad
  // input); anything else is logged and answered generically.
  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) return sendInternalError(reply, error);
    return reply.status(status).send({ error: error.message });
  });

  // Security Hardening: Helmet Security Headers & Rate Limiting
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  await app.register(rateLimit, {
    max: parseInt(process.env.RATE_LIMIT_MAX || '600', 10),
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
  });

  // Authoritative OpenAPI 3.1 Swagger Registration
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Prep404 Distributed Core API Specification',
        version: '1.0.0',
        description: 'Authoritative OpenAPI contract for Prep404 Mobile, Admin Studio, and Edge services.',
      },
      servers: [
        { url: 'http://localhost:4040', description: 'Local Fastify Core Daemon' },
        { url: 'https://api.prep404.com', description: 'Production Edge Gateway' },
      ],
    },
  });

  // OpenAPI Specification Endpoint
  app.get('/api/v1/openapi.json', async (_req, reply) => {
    const candidates = [
      path.resolve(__dirname, '../../docs/openapi.json'),
      path.resolve(process.cwd(), 'docs/openapi.json'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf-8');
        return reply.type('application/json').send(content);
      }
    }
    return app.swagger();
  });

  // Global Core Plugins
  // Browsers may call the API only from listed origins (admin, landing, web app).
  // Requests without an Origin header (the mobile app, server-to-server) are allowed.
  // Outside production, any localhost origin is allowed for local development.
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const isLocalDevOrigin = (origin: string) =>
    process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || isLocalDevOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(jwt, {
    secret: JWT_SECRET,
  });

  // Real-Time RFC 6455 WebSocket Engine for 1v1 Multi-Section Duels
  const realBattleGateway = new RealBattleGateway(db, redisService);
  const wss = new WebSocketServer({ server: app.server, path: '/ws/battle', maxPayload: 8 * 1024 });
  wss.on('connection', (socket) => {
    realBattleGateway.handleConnection(socket);
  });

  // Dynamic University and Program Patterns for Real Duels (100% DB-driven)
  app.get('/api/v1/battle/university-programs', async (_req, reply) => {
    try {
      const unis = await db.query(
        `SELECT u.id, u.code, u.short_name, u.full_name,
                COALESCE(json_agg(
                  json_build_object(
                    'id', p.id,
                    'name', p.pattern_name,
                    'slug', p.slug,
                    'sections', p.sections
                  )
                ) FILTER (WHERE p.id IS NOT NULL), '[]') as patterns
         FROM universities u
         LEFT JOIN admission_test_patterns p ON p.university_id = u.id
         WHERE u.is_active = true
         GROUP BY u.id, u.code, u.short_name, u.full_name
         ORDER BY u.code`
      );
      return reply.send({ success: true, data: unis.rows });
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // Health Check
  app.get('/health', async () => ({
    status: 'online',
    platform: 'Prep404 Competitive Engine',
    timestamp: new Date().toISOString(),
  }));

  // Dedicated Web-Based Admin Panel & Faculty Management Studio
  app.get('/admin', async (_req, reply) => {
    return reply.redirect(process.env.ADMIN_URL || 'http://localhost:3001');
  });

  // Public Model Test Candidate Experience (prep404.com/m/:slug)
  app.get('/m/:slug', async (_req, reply) => {
    const candidatePaths = [
      path.resolve(process.cwd(), 'admin/candidate_exam.html'),
      path.resolve(process.cwd(), '../admin/candidate_exam.html'),
      path.resolve(__dirname, '../../admin/candidate_exam.html'),
      path.resolve(__dirname, '../admin/candidate_exam.html'),
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        const html = await fs.promises.readFile(p, 'utf-8');
        return reply.type('text/html').send(html);
      }
    }
    return reply.status(404).send('Candidate exam portal not found');
  });

  // Register Modular Route Handlers
  const routeOptions = { db, redis: redisService };
  app.decorate('db', db);
  app.decorate('redisService', redisService);
  await app.register(authRoutes, routeOptions);
  await app.register(onboardingRoutes, routeOptions);
  await app.register(questionRoutes, routeOptions);
  await app.register(examRoutes, routeOptions);
  await app.register(publicExamRoutes, routeOptions);
  await app.register(admissionJourneyRoutes, { db });
  await app.register(managementRoutes, routeOptions);
  await app.register(questionManagementRoutes, routeOptions);
  await app.register(academicManagementRoutes, routeOptions);
  await app.register(blueprintManagementRoutes, routeOptions);
  await app.register(aiVariantGeneratorRoutes);
  await app.register(practiceRoutes, routeOptions);
  await app.register(aiRoutes, routeOptions);
  await app.register(supportRoutes, routeOptions);
  await app.register(accountRoutes, routeOptions);
  await app.register(battleModerationRoutes, routeOptions);
  await app.register(learnerAnalyticsRoutes, { db, redis: redisService });
  await app.register(streakRoutes, { db });
  await app.register(notificationRoutes, { db });
  await app.register(telemetryRoutes, routeOptions);

  // Auto-capture 5xx server errors and uncaught exceptions into telemetry buffer
  app.addHook('onError', async (request, _reply, error) => {
    try {
      const telemetry = TelemetryBatchService.getInstance();
      if (telemetry) {
        await telemetry.enqueue({
          level: 'error',
          source: 'server',
          event: 'api_unhandled_error',
          message: error.message,
          errorStack: error.stack,
          metadata: {
            url: request.url,
            method: request.method,
            ip: request.ip,
          },
        });
      }
    } catch (_) {}
  });

  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode >= 500) {
      try {
        const telemetry = TelemetryBatchService.getInstance();
        if (telemetry) {
          await telemetry.enqueue({
            level: 'error',
            source: 'server',
            event: 'api_5xx_response',
            message: `HTTP ${reply.statusCode} on ${request.method} ${request.url}`,
            metadata: {
              statusCode: reply.statusCode,
              url: request.url,
              method: request.method,
              responseTimeMs: reply.getResponseTime(),
            },
          });
        }
      } catch (_) {}
    }
  });

  return app;
}

// Start Server
if (require.main === module || !process.env.TEST_MODE) {
  (async () => {
    try {
      // In production connect() throws when Redis is unreachable and the
      // server refuses to start; in development it falls back to memory.
      await redisService.connect();

      const app = await buildApp();
      startExamSessionRetentionJob(db, (err) => console.warn('[Exam telemetry] Retention cleanup unavailable:', err instanceof Error ? err.message : 'database error'));
      startLearnerAnalyticsRetentionJob(db, (err) => console.warn('[Learner analytics] Retention cleanup unavailable:', err instanceof Error ? err.message : 'database error'));
      await app.listen({ port: PORT, host: HOST });
      console.log(`[Prep404 Server] Running on http://${HOST}:${PORT}`);
    } catch (err) {
      console.error('[Prep404 Server] Failed to start:', err);
      process.exit(1);
    }
  })();
}
