import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { RedisService } from '../redis/redis.service';
import { sendInternalError } from '../services/http_errors';
import type { ExamRouteOptions } from './exam.routes';
import { resolveCandidateIdentity } from '../services/learner_identity.service';

/** Today's daily test (cached question set + live standings) and the past-tests archive. */
export const dailyTestRoutes: FastifyPluginAsync<ExamRouteOptions> = async (
  app: FastifyInstance,
  opts: ExamRouteOptions,
) => {
  const { db, redis } = opts;

  // =========================================================================
  // ONE SINGLE ENDPOINT FOR TODAY'S DAILY TEST (ZERO DB QUERY AT PEAK)
  // Served directly from pre-compiled Redis/RAM cache snapshot like a static web page
  // =========================================================================
  app.get('/api/v1/daily-test/today', async (
    req: FastifyRequest<{ Querystring: { university?: string } }>,
    reply: FastifyReply
  ) => {
    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });
    const uni = (req.query.university || 'all').toLowerCase();
    // The university code feeds a SQL label and a Redis cache key; accept codes only.
    if (!/^[a-z0-9_-]{1,32}$/.test(uni)) {
      return reply.status(400).send({ error: 'Invalid university code.' });
    }
    const userId = identity.userId;
    const cacheKey = `daily_test:today:${uni}`;

    let compiledPayload: any = null;

    // 1. Check Redis/RAM cache snapshot
    const cachedTest = await redis.getSessionKey(cacheKey);
    if (cachedTest) {
      try {
        compiledPayload = JSON.parse(cachedTest);
      } catch (_) {}
    }

    // 2. If not cached, query DB once, build payload, and cache
    if (!compiledPayload) {
      if (!db) return reply.status(503).send({ error: 'Database service unavailable' });

      try {
        let query = `
          SELECT e.id, e.title, e.track, ROUND(e.duration_seconds / 60) AS "durationMinutes",
                 e.total_marks AS "totalMarks", COALESCE(e.negative_mark_per_question, 0.25) AS "negativeMark",
                 u.code AS "universityCode", u.full_name AS "universityName", u.logo_url AS "universityLogo"
          FROM exams e
          LEFT JOIN universities u ON u.id = e.target_university_id
          WHERE e.is_active = true
            AND (e.starts_at IS NULL OR e.starts_at <= now())
            AND (e.ends_at IS NULL OR e.ends_at > now())
        `;
        const params: any[] = [];
        if (uni !== 'all') {
          params.push(uni);
          query += ` AND (LOWER(u.code) = $1 OR LOWER(u.slug) = $1)`;
        }
        query += ` ORDER BY e.created_at DESC LIMIT 1`;

        let examRes = await db.query(query, params);
        if (examRes.rows.length === 0) {
          // Fallback to any latest active exam
          examRes = await db.query(`
            SELECT e.id, e.title, e.track, ROUND(e.duration_seconds / 60) AS "durationMinutes",
                   e.total_marks AS "totalMarks", COALESCE(e.negative_mark_per_question, 0.25) AS "negativeMark",
                   u.code AS "universityCode", u.full_name AS "universityName", u.logo_url AS "universityLogo"
            FROM exams e
            LEFT JOIN universities u ON u.id = e.target_university_id
            WHERE e.is_active = true
              AND (e.starts_at IS NULL OR e.starts_at <= now())
              AND (e.ends_at IS NULL OR e.ends_at > now())
            ORDER BY e.created_at DESC LIMIT 1
          `);
          if (examRes.rows.length === 0) {
            return reply.status(404).send({ error: 'No active daily test scheduled for today' });
          }
        }

        const exam = examRes.rows[0];

        // Fetch questions once to build the compiled snapshot (with stimulus passages and cloze context)
        const qRes = await db.query(`
          SELECT eq.question_order AS "order", q.id, q.stem_primary AS "questionText",
                 (q.stem_primary LIKE '%$%' OR q.stem_primary LIKE '%\\%') AS "hasMath",
           q.options, q.difficulty_rating AS "difficultyRating", s.name AS "subjectName",
                 q.context_snippet AS "contextSnippet",
                 qs.content_text AS "passage",
                 qs.title AS "passageTitle"
          FROM exam_questions eq
          JOIN questions q ON q.id = eq.question_id
          LEFT JOIN academic_subjects s ON s.id = q.subject_id
          LEFT JOIN question_stimuli qs ON (qs.id = q.stimulus_id OR qs.external_slug = q.stimulus_id::text)
          WHERE eq.exam_id = $1::uuid AND q.is_active = true AND q.review_status = 'approved'
          ORDER BY eq.question_order ASC;
        `, [exam.id]);

        const sanitizedQuestions = qRes.rows.map((row) => {
          const rawOpts = Array.isArray(row.options) ? row.options : [];
          const options = rawOpts.map((opt: any, idx: number) => {
            const optId = opt.key_original || opt.id || String.fromCharCode(65 + idx);
            return {
              id: optId,
              text: opt.text || '',
            };
          });
          return {
            id: row.id,
            order: row.order,
            subject: row.subjectName || 'General',
            questionText: row.questionText,
            passage: row.passage || null,
            contextSnippet: row.contextSnippet || null,
            hasMath: row.hasMath,
             options,
            difficultyRating: parseFloat(row.difficultyRating || '1.0'),
          };
        });

        const uCode = exam.universityCode || uni.toUpperCase();

        compiledPayload = {
          success: true,
          date: new Date().toISOString().split('T')[0],
          examId: exam.id,
          slug: exam.id,
          shareableUrl: `https://prep404.com/m/${exam.id}`,
          title: exam.title,
          track: exam.track,
          universityCode: uCode,
          universityName: exam.universityName || `${uCode} University`,
          universityLogo: exam.universityLogo || '',
          durationMinutes: exam.durationMinutes || 30,
          totalMarks: exam.totalMarks || 50,
          negativeMark: exam.negativeMark ?? 0.25,
          totalQuestions: sanitizedQuestions.length,
          userRank: 'Unranked (Take 1 test)',
          questions: sanitizedQuestions,
        };

        // Cache the question set only. 10 minutes keeps peak traffic off the
        // database while letting a newly published exam replace it quickly.
        await redis.setSessionKey(cacheKey, JSON.stringify(compiledPayload), 600);
      } catch (err: any) {
        return sendInternalError(reply, err);
      }
    }

    // 3. User submission check (enforce 1 ranked attempt per candidate)
    if (db && compiledPayload?.examId) {
      try {
        const availability = await db.query(`SELECT 1 FROM public.exams WHERE id=$1::uuid AND is_active=true
          AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())`, [compiledPayload.examId]);
        if (!availability.rowCount) return reply.status(404).send({ error: 'No active daily test is available right now.' });
      } catch (err) {
        req.log.error({ err }, 'Daily test availability check failed');
        return reply.status(503).send({ error: 'Daily test availability could not be verified.' });
      }
    } else {
      return reply.status(503).send({ error: 'Daily test availability could not be verified.' });
    }

    // Leaderboard and participant count change with every submission, so they
    // are cached separately for one minute instead of with the question set.
    let leaderboard: Array<{ rank: string; name: string; score: string; badge: string }> = [];
    let enrolledCount = 0;
    const standingsKey = `daily_test:standings:${compiledPayload.examId}`;
    const cachedStandings = await redis.getSessionKey(standingsKey);
    if (cachedStandings) {
      try { ({ leaderboard, enrolledCount } = JSON.parse(cachedStandings)); } catch (_) { /* rebuilt below */ }
    }
    if (!cachedStandings) {
      try {
        const uCode = compiledPayload.universityCode;
        const totalMarks = compiledPayload.totalMarks || 50;
        const subRes = await db.query(`
          SELECT s.score, COALESCE(s.candidate_name, u.full_name) AS "name",
                 COALESCE(s.candidate_institution, u.institution_name, $2::text) AS "badge"
          FROM exam_submissions s
          LEFT JOIN users u ON u.id = s.user_id
          WHERE s.exam_id = $1::uuid AND s.is_practice = false
          ORDER BY s.score DESC, s.time_taken_seconds ASC
          LIMIT 10;
        `, [compiledPayload.examId, `${uCode} Batch`]);
        leaderboard = subRes.rows.map((r: any, i: number) => ({
          rank: i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : `#${i + 1}`)),
          name: r.name || `Candidate #${100 + i}`,
          score: `${parseFloat(r.score).toFixed(1)} / ${totalMarks}`,
          badge: r.badge || `${uCode} Batch`,
        }));
        const countRes = await db.query(
          'SELECT COUNT(DISTINCT user_id) AS "count" FROM exam_submissions WHERE exam_id = $1::uuid AND is_practice = false',
          [compiledPayload.examId]
        );
        enrolledCount = parseInt(countRes.rows[0]?.count || '0', 10);
        await redis.setSessionKey(standingsKey, JSON.stringify({ leaderboard, enrolledCount }), 60);
      } catch (err) {
        req.log.warn({ err }, 'Daily test standings unavailable');
      }
    }

    let hasAttempted = false;
    let userSubmission: any = null;
    if (db && userId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      try {
        const sub = await db.query(`
          SELECT score, rank, correct_count AS "correctCount", wrong_count AS "wrongCount",
                 time_taken_seconds AS "timeTakenSeconds", submitted_at AS "submittedAt"
          FROM exam_submissions
          WHERE exam_id = $1::uuid AND user_id = $2::uuid AND is_practice = false
          ORDER BY submitted_at ASC LIMIT 1;
        `, [compiledPayload.examId, userId]);
        if (sub.rows.length > 0) {
          hasAttempted = true;
          userSubmission = sub.rows[0];
        }
      } catch (_) {}
    }

    // 4. Canonical Bangladesh Time (BST, UTC+6) Slot State
    const nowUtc = new Date();
    const bstDate = new Date(nowUtc.getTime() + (6 * 60 * 60 * 1000));
    const bstHour = bstDate.getUTCHours();
    let slotState: 'upcoming' | 'live' | 'closed' = 'closed';
    if (bstHour >= 10 && bstHour < 22) {
      slotState = 'live';
    } else if (bstHour < 10) {
      slotState = 'upcoming';
    } else {
      slotState = 'closed';
    }

    return reply.send({
      ...compiledPayload,
      enrolledCount,
      leaderboard,
      hasAttempted,
      userSubmission,
      slotState,
      isLive: slotState === 'live',
      slug: compiledPayload.examId,
      shareableUrl: `https://prep404.com/m/${compiledPayload.examId}`,
    });
  });

  // =========================================================================
  // PAST DAILY TESTS & MISSED EXAMS (PRACTICE ARCHIVE - UNRANKED)
  // =========================================================================
  app.get('/api/v1/daily-test/past', async (
    req: FastifyRequest<{ Querystring: { university?: string } }>,
    reply: FastifyReply
  ) => {
    if (!db) return reply.status(503).send({ error: 'Database service unavailable' });
    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });
    const uni = (req.query.university || 'brac').toLowerCase();
    const userId = identity.userId;
    const isValidUuid = userId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);

    try {
      const uniRes = await db.query(
        'SELECT id, code, full_name, slug FROM universities WHERE LOWER(code) = $1 OR LOWER(slug) = $1 LIMIT 1',
        [uni]
      );
      if (uniRes.rows.length === 0) {
        return reply.status(404).send({ error: 'University not found' });
      }
      const university = uniRes.rows[0];

      // Query past exams (offset 1 to skip today's latest daily test)
      const pastQuery = `
        SELECT 
          e.id, 
          e.title,
          ROUND(e.duration_seconds / 60) AS "durationMinutes",
          e.total_marks AS "totalMarks",
          COALESCE(e.negative_mark_per_question, 0.25) AS "negativeMark",
          TO_CHAR(e.created_at, 'Mon DD, YYYY') AS "date",
          (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS "totalQuestions",
          sub.score AS "userScore",
          sub.rank AS "userRank",
          (sub.id IS NOT NULL) AS "hasAttempted"
        FROM exams e
        LEFT JOIN exam_submissions sub 
          ON (sub.exam_id = e.id AND sub.user_id = $2::uuid AND sub.is_practice = false)
        WHERE e.is_active = true 
          AND e.target_university_id = $1::uuid
        ORDER BY e.created_at DESC
        OFFSET 1
        LIMIT 10;
      `;
      const dummyUuid = '00000000-0000-0000-0000-000000000000';
      const pastRes = await db.query(pastQuery, [university.id, isValidUuid ? userId : dummyUuid]);

      const pastExams = pastRes.rows.map((r) => ({
        id: r.id,
        slug: r.id,
        shareableUrl: `https://prep404.com/m/${r.id}`,
        title: r.title,
        durationMinutes: parseInt(r.durationMinutes || '30', 10),
        totalMarks: parseFloat(r.totalMarks || '50'),
        negativeMark: parseFloat(r.negativeMark || '0.25'),
        totalQuestions: parseInt(r.totalQuestions || '25', 10),
        date: r.date,
        hasAttempted: r.hasAttempted === true,
        userScore: r.userScore !== null ? parseFloat(r.userScore) : null,
        userRank: r.userRank !== null ? parseInt(r.userRank, 10) : null,
      }));

      return {
        success: true,
        universityCode: university.code,
        universityName: university.full_name,
        pastExams,
      };
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });
};
