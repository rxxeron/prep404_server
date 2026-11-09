import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { SupabaseAuthVerificationError, verifySupabaseAccessToken } from '../services/supabase_auth.service';

const DeleteAccountSchema = z.object({
  reason: z.enum([
    'no_longer_needed',
    'privacy_concerns',
    'technical_issues',
    'switching_service',
    'other',
    'prefer_not_to_say',
  ]).default('prefer_not_to_say'),
});

export const accountRoutes: FastifyPluginAsync<{ db: Pool }> = async (
  app: FastifyInstance,
  opts: { db: Pool },
) => {
  app.delete('/api/v1/user/account', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsedBody = DeleteAccountSchema.safeParse(req.body || {});
    if (!parsedBody.success) return reply.status(400).send({ error: 'Choose a valid account deletion reason.' });
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) return reply.status(401).send({ error: 'Sign in to delete your account.' });

    let userId: string;
    try {
      userId = (await verifySupabaseAccessToken(bearer)).id;
    } catch (err) {
      const statusCode = err instanceof SupabaseAuthVerificationError ? err.statusCode : 503;
      return reply.status(statusCode).send({ error: err instanceof Error ? err.message : 'Account verification is unavailable.' });
    }

    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !serviceKey) {
      return reply.status(503).send({ error: 'Account deletion is not configured on the server.' });
    }

    let client: PoolClient | undefined;
    try {
      client = await opts.db.connect();
      await client.query('BEGIN');
      // Keep the profile deletion and Auth deletion coordinated. If Auth rejects,
      // rollback the profile change so the learner can retry safely.
      const subjectHash = createHash('sha256').update(userId).digest('hex');
      await client.query(
        `INSERT INTO public.staff_audit_logs
          (actor_email, actor_role, action, entity_type, entity_id, metadata)
         VALUES ($1, 'learner', 'learner.account.deleted', 'learner_account', $1, $2::jsonb)`,
        [`deleted:${subjectHash}`, JSON.stringify({ subjectHash, channel: 'self_service', reason: parsedBody.data.reason })],
      );
      await client.query('DELETE FROM public.users WHERE id = $1::uuid', [userId]);
      const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        signal: AbortSignal.timeout(7000),
      });
      if (!response.ok) {
        await client.query('ROLLBACK');
        req.log.error({ status: response.status }, 'Supabase account deletion failed');
        return reply.status(503).send({ error: 'Your account could not be deleted. Please try again.' });
      }
      await client.query('COMMIT');
      return reply.send({ success: true });
    } catch (err) {
      try { await client?.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
      req.log.error({ err }, 'Account deletion failed');
      return reply.status(503).send({ error: 'Your account could not be deleted. Please try again.' });
    } finally {
      client?.release();
    }
  });
};
