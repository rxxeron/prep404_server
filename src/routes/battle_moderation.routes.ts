import { createHash, randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { RedisService } from '../redis/redis.service';
import { requireStaffRole } from '../middleware/rbac.middleware';
import { SupabaseAuthVerificationError, verifySupabaseAccessToken } from '../services/supabase_auth.service';

const directContact = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+?880|0)?1[3-9](?:[\s()-]*\d){8}/;
const learnerSchema = z.object({
  battleId: z.string().min(1),
  category: z.enum(['cheating', 'harassment', 'inappropriate_name', 'other']),
  details: z.string().trim().max(1000).refine((value) => !directContact.test(value), 'Do not include phone numbers or email addresses.').default(''),
});

export const battleModerationRoutes: FastifyPluginAsync<{ db: Pool; redis: RedisService }> = async (app: FastifyInstance, opts) => {
  /**
   * GET /api/v1/battle/history
   * Retrieves player's past 1v1 PvP duel match history with opponent details, scores, and outcomes
   */
  app.get('/api/v1/battle/history', async (req, reply) => {
    let userId = (req.query as any)?.userId;
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!userId && token) {
      try {
        userId = (await verifySupabaseAccessToken(token)).id;
      } catch (_) {}
    }

    if (!userId) {
      return reply.status(400).send({ success: false, error: 'User ID is required' });
    }

    try {
      const q = `
        SELECT 
          b.id,
          b.room_code AS "roomCode",
          b.track,
          b.status,
          b.winner_id AS "winnerId",
          b.player_ids AS "playerIds",
          b.round_scores AS "roundScores",
          b.created_at AS "createdAt",
          COALESCE(u.full_name, 'Candidate') AS "opponentName",
          COALESCE(u.institution_name, 'Admission Candidate') AS "opponentCollege"
        FROM public.battle_rooms b
        LEFT JOIN public.users u ON u.id = CASE 
          WHEN b.player_ids[1] = $1::uuid THEN b.player_ids[2]
          ELSE b.player_ids[1]
        END
        WHERE b.player_ids @> ARRAY[$1::uuid]
        ORDER BY b.created_at DESC
        LIMIT 30;
      `;

      const result = await opts.db.query(q, [userId]);

      let wins = 0;
      let losses = 0;
      let draws = 0;

      const items = result.rows.map((row: any) => {
        const isPlayer1 = row.playerIds && row.playerIds[0] === userId;
        const scores = row.roundScores || {};
        const p1Score = Number(scores.player1Score || 0);
        const p2Score = Number(scores.player2Score || 0);
        const yourScore = isPlayer1 ? p1Score : p2Score;
        const opponentScore = isPlayer1 ? p2Score : p1Score;

        let outcome: 'victory' | 'defeat' | 'draw' = 'defeat';
        if (row.winnerId === userId || yourScore > opponentScore) {
          outcome = 'victory';
          wins++;
        } else if (row.winnerId == null && yourScore === opponentScore) {
          outcome = 'draw';
          draws++;
        } else {
          losses++;
        }

        return {
          id: row.id,
          roomCode: row.roomCode,
          track: row.track,
          status: row.status,
          outcome,
          yourScore,
          opponentScore,
          opponent: {
            name: row.opponentName,
            college: row.opponentCollege,
          },
          createdAt: row.createdAt,
        };
      });

      const totalBattles = items.length;
      const winRate = totalBattles > 0 ? Math.round((wins / totalBattles) * 100) : 0;

      return reply.send({
        success: true,
        summary: {
          totalBattles,
          wins,
          losses,
          draws,
          winRate,
        },
        history: items,
      });
    } catch (err: any) {
      req.log.error({ err }, 'Failed to fetch battle match history');
      return reply.status(500).send({ success: false, error: 'Failed to fetch match history' });
    }
  });

  app.post('/api/v1/battle/reports', async (req, reply) => {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return reply.status(401).send({ error: 'Sign in to report a battle.' });
    let reporterId: string;
    try {
      reporterId = (await verifySupabaseAccessToken(token)).id;
    } catch (err) {
      const status = err instanceof SupabaseAuthVerificationError ? err.statusCode : 503;
      return reply.status(status).send({ error: status === 401 ? 'Your sign-in has expired.' : 'Sign-in verification is temporarily unavailable.' });
    }
    const parsed = learnerSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });

    if (parsed.data.battleId.startsWith('room_bot_')) {
      return reply.status(400).send({
        error: 'Practice bot matches cannot be reported for player misconduct. Use Question Report for question issues.',
      });
    }

    const limit = await opts.redis.checkRateLimit(`battle_report:${createHash('sha256').update(reporterId).digest('hex')}`, 3, 86400);
    if (!limit.allowed) return reply.status(429).send({ error: 'You have reached today’s battle report limit.' });

    let client;
    try {
      client = await opts.db.connect();
      await client.query('BEGIN');
      const battle = await client.query(`SELECT player_ids FROM public.battle_rooms
        WHERE id=$1::uuid AND status IN ('in_progress','finished')
          AND player_ids @> ARRAY[$2::uuid]`, [parsed.data.battleId, reporterId]);
      if (!battle.rowCount) {
        await client.query('ROLLBACK');
        return reply.status(404).send({ error: 'This battle is not available for reporting.' });
      }
      const players: string[] = battle.rows[0].player_ids;
      const reportedPlayerId = players.find((id) => id !== reporterId);
      if (!reportedPlayerId) {
        await client.query('ROLLBACK');
        return reply.status(400).send({ error: 'This battle has no reportable opponent.' });
      }
      const reportId = randomUUID();
      await client.query(`INSERT INTO public.battle_reports
          (id, battle_id, reporter_id, reported_player_id, category, details)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6)`, [
        reportId, parsed.data.battleId, reporterId, reportedPlayerId, parsed.data.category, parsed.data.details,
      ]);
      const actorRef = createHash('sha256').update(reporterId).digest('hex').slice(0, 20);
      await client.query(`INSERT INTO public.staff_audit_logs
          (actor_email, actor_role, action, entity_type, entity_id, metadata)
        VALUES ($1,'learner','battle.reported','battle_report',$2,$3::jsonb)`, [
        `learner:${actorRef}`, reportId, JSON.stringify({ battleId: parsed.data.battleId, category: parsed.data.category }),
      ]);
      await client.query('COMMIT');
      return reply.code(201).send({ success: true, id: reportId });
    } catch (err: any) {
      await client?.query('ROLLBACK').catch(() => undefined);
      if (err?.code === '23505') return reply.status(409).send({ error: 'You have already reported this battle.' });
      req.log.error({ err }, 'Battle report could not be saved');
      return reply.status(503).send({ error: 'This report could not be saved right now.' });
    } finally { client?.release(); }
  });

  app.get('/api/v1/management/battle-reports',
    { preHandler: [requireStaffRole(['moderator', 'super_admin'])] }, async (req, reply) => {
      const status = String((req.query as any)?.status || 'open');
      if (!['open', 'in_review', 'resolved', 'dismissed', 'all'].includes(status)) {
        return reply.status(400).send({ error: 'Invalid battle report status.' });
      }
      const limit = Math.min(100, Math.max(1, Number((req.query as any)?.limit) || 50));
      try {
        const result = await opts.db.query(`SELECT r.id, r.battle_id AS "battleId",
            left(r.reporter_id::text,8) AS "reporterRef",
            left(r.reported_player_id::text,8) AS "reportedPlayerRef",
            r.category, r.details, r.status, r.review_note AS "reviewNote",
            r.reviewed_by AS "reviewedBy", r.reviewed_at AS "reviewedAt",
            r.created_at AS "createdAt", b.track
          FROM public.battle_reports r JOIN public.battle_rooms b ON b.id=r.battle_id
          WHERE ($1='all' OR r.status=$1)
          ORDER BY r.created_at DESC LIMIT $2`, [status, limit]);
        return { reports: result.rows };
      } catch (err: any) {
        if (err?.code === '42P01') return { reports: [], available: false };
        req.log.error({ err }, 'Battle report queue unavailable');
        return reply.status(503).send({ error: 'Battle reports are temporarily unavailable.' });
      }
    });

  app.post('/api/v1/management/battle-reports/:id/review',
    { preHandler: [requireStaffRole(['moderator', 'super_admin'])] }, async (req: any, reply) => {
      const parsed = z.object({
        status: z.enum(['in_review', 'resolved', 'dismissed']),
        note: z.string().trim().min(3).max(1000).refine((value) => !directContact.test(value), 'Do not include phone numbers or email addresses.'),
      }).safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message });
      let client;
      try {
        client = await opts.db.connect();
        await client.query('BEGIN');
        const report = await client.query(`SELECT id, status FROM public.battle_reports
          WHERE id=$1::uuid FOR UPDATE`, [req.params.id]);
        if (!report.rowCount) {
          await client.query('ROLLBACK');
          return reply.status(404).send({ error: 'Battle report not found.' });
        }
        if (['resolved', 'dismissed'].includes(report.rows[0].status)) {
          await client.query('ROLLBACK');
          return reply.status(409).send({ error: 'This report is already closed.' });
        }
        await client.query(`UPDATE public.battle_reports
          SET status=$2, review_note=$3, reviewed_by=$4, reviewed_at=now()
          WHERE id=$1::uuid`, [req.params.id, parsed.data.status, parsed.data.note, req.staffUser.email]);
        await client.query(`INSERT INTO public.staff_audit_logs
            (actor_email, actor_role, action, entity_type, entity_id, metadata)
          VALUES ($1,$2,'battle.report.reviewed','battle_report',$3,$4::jsonb)`, [
          req.staffUser.email, req.staffUser.role, req.params.id,
          JSON.stringify({ status: parsed.data.status, note: parsed.data.note }),
        ]);
        await client.query('COMMIT');
        return { success: true };
      } catch (err: any) {
        await client?.query('ROLLBACK').catch(() => undefined);
        if (err?.code === '22P02') return reply.status(400).send({ error: 'Invalid battle report ID.' });
        req.log.error({ err }, 'Battle report review failed');
        return reply.status(503).send({ error: 'Unable to update this battle report.' });
      } finally { client?.release(); }
    });
};
