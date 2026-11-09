import { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { RedisService } from '../redis/redis.service';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { SupabaseAuthVerificationError, verifySupabaseAccessToken } from '../services/supabase_auth.service';
import { recordLearnerEvent } from '../services/learner_analytics.service';
import { sendInternalError } from '../services/http_errors';

export const practiceRoutes: FastifyPluginAsync<{ db?: Pool; redis?: RedisService }> = async (
  app: FastifyInstance,
  opts: { db?: Pool; redis?: RedisService }
) => {
  const db = opts.db;

  app.post('/api/v1/practice/attempts', async (req, reply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) return reply.status(401).send({ error: 'Sign in to save practice progress.' });
    let userId: string;
    try { userId = (await verifySupabaseAccessToken(bearer)).id; }
    catch (error) {
      const status = error instanceof SupabaseAuthVerificationError ? error.statusCode : 503;
      return reply.status(status).send({ error: status === 401 ? 'Your sign-in has expired. Sign in again.' : 'Sign-in verification is temporarily unavailable.' });
    }
    const rateKey = `practice_attempt:${createHash('sha256').update(userId).digest('hex')}`;
    const rate = await opts.redis?.checkRateLimit(rateKey, 120, 60);
    if (rate && !rate.allowed) return reply.status(429).send({ error: 'Practice answer rate limit reached. Try again shortly.' });
    const parsed = z.object({ attemptId: z.string().uuid(), questionId: z.string().uuid(), selectedOptionId: z.string().trim().min(1).max(20) }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
    try {
      const { attemptId, questionId, selectedOptionId } = parsed.data;
      const question = await db.query(`SELECT q.options, q.solution_markdown AS explanation, q.subject_id AS "subjectId", q.topic_id AS "topicId"
        FROM public.questions q WHERE q.id=$1::uuid AND q.is_active=true AND q.review_status='approved'`, [questionId]);
      if (!question.rowCount) return reply.status(404).send({ error: 'This question is no longer available for practice.' });
      const options = Array.isArray(question.rows[0].options) ? question.rows[0].options : [];
      const correct = options.filter((option: any) => option?.is_correct === true);
      const keys = options.map((option: any, index: number) => String(option?.key_original || String.fromCharCode(65 + index)));
      if (correct.length !== 1 || !keys.includes(selectedOptionId)) return reply.status(409).send({ error: 'This question is not ready for scoring.' });
      const correctOptionId = String(correct[0].key_original || correct[0].id || keys[options.indexOf(correct[0])]);
      const isCorrect = selectedOptionId === correctOptionId;
      const inserted = await db.query(`INSERT INTO public.practice_attempts (attempt_id,user_id,question_id,subject_id,topic_id,selected_option_id,is_correct)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7) ON CONFLICT (attempt_id) DO NOTHING RETURNING attempt_id`,
      [attemptId,userId,questionId,question.rows[0].subjectId,question.rows[0].topicId,selectedOptionId,isCorrect]);
      if (!inserted.rowCount) {
        const previous = await db.query(`SELECT question_id,is_correct,selected_option_id FROM public.practice_attempts WHERE attempt_id=$1::uuid AND user_id=$2::uuid`, [attemptId,userId]);
        if (!previous.rowCount || previous.rows[0].question_id !== questionId || previous.rows[0].selected_option_id !== selectedOptionId) return reply.status(409).send({ error: 'This attempt ID was already used.' });
      }
      if (inserted.rowCount) {
        try { await recordLearnerEvent(db, userId, 'practice_attempted'); }
        catch (err) { req.log.warn({ err }, 'Optional practice analytics event was not recorded'); }
      }
      return { attemptId, questionId, isCorrect, correctOptionId, explanation: question.rows[0].explanation || '' };
    } catch (error) {
      req.log.error({ err: error }, 'Practice attempt could not be saved');
      return reply.status(503).send({ error: 'Practice scoring is temporarily unavailable.' });
    }
  });

  // Duolingo-Style Practice Map (Topic Mastery from Supabase PostgreSQL)
  app.get('/api/v1/practice-map/nodes', async (_req, reply: FastifyReply) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

    try {
      const res = await db.query(`
        SELECT 
          t.id,
          t.name AS title,
          s.name AS subject,
          s.slug AS "subjectSlug",
          t.slug AS "topicSlug",
          (
            SELECT COUNT(*) 
            FROM questions q 
            WHERE q.topic_id = t.id AND q.is_active = true
          ) AS "questionCount"
        FROM academic_topics t
        JOIN academic_subjects s ON s.id = t.subject_id
        ORDER BY s.display_order ASC, t.name ASC;
      `);

      const nodes = res.rows.map((row, idx) => ({
        id: row.id,
        title: row.title,
        subject: row.subject,
        subjectSlug: row.subjectSlug,
        topicSlug: row.topicSlug,
        questionCount: parseInt(row.questionCount, 10) || 0,
        order: idx + 1,
        // This endpoint has no per-learner progress source; never imply completion.
        stars: 0,
        isCompleted: false,
        isLocked: false,
        xpReward: 100,
        dueReviewCount: 0,
      }));

      return {
        track: 'Private University Admission',
        totalNodes: nodes.length,
        progressAvailable: false,
        nodes,
      };
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });
};
