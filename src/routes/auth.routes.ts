import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Pool } from 'pg';
import { RedisService } from '../redis/redis.service';
import { createHash, randomUUID } from 'node:crypto';
import { requireStaffRole, StaffRole, StaffJwtPayload } from '../middleware/rbac.middleware';
import { burnStaffPasswordCheck, STAFF_PASSWORD_MIN_LENGTH, verifyStaffPassword } from '../services/staff_credentials.service';
import { SupabaseAuthVerificationError, verifySupabaseAccessToken } from '../services/supabase_auth.service';

export const authRoutes: FastifyPluginAsync<{ db: Pool; redis: RedisService }> = async (
  app: FastifyInstance,
  opts: { db: Pool; redis: RedisService }
) => {
  const { db, redis } = opts;

  const issueManagedStaffSession = async (
    req: FastifyRequest,
    reply: FastifyReply,
    staff: { id: string; email: string; name: string; role: StaffRole; sessionVersion: number },
    authMethod: 'password' | 'google',
  ) => {
    const sessionId = randomUUID();
    const token = app.jwt.sign({
      userId: staff.id,
      email: staff.email,
      role: staff.role,
      name: staff.name,
      sessionId,
      managedAccount: true,
      sessionVersion: staff.sessionVersion,
    }, { expiresIn: '8h' });
    const sessionKey = `staff:session:${createHash('sha256').update(sessionId).digest('hex')}`;
    await redis.set(sessionKey, staff.id, 8 * 60 * 60);
    try {
      await db.query(`INSERT INTO public.staff_audit_logs
          (actor_email, actor_role, action, entity_type, entity_id, metadata)
        VALUES ($1,$2,'staff.session.created','staff_session',$3,$4::jsonb)`, [
        staff.email,
        staff.role,
        createHash('sha256').update(sessionId).digest('hex'),
        JSON.stringify({ scope: 'current_session', managedAccount: true, ...(authMethod === 'google' ? { authMethod } : {}) }),
      ]);
    } catch (err) {
      try { await redis.del(sessionKey); }
      catch (revokeError) { req.log.error({ err: revokeError }, 'Unrecorded staff session could not be revoked'); }
      req.log.error({ err }, 'Staff session audit failed; sign-in was rejected');
      return reply.status(503).send({ error: 'Staff sign-in is temporarily unavailable. Please try again.' });
    }

    return {
      success: true,
      token,
      staff: {
        email: staff.email,
        name: staff.name,
        role: staff.role,
        permissions: ['read', 'write', staff.role],
      },
    };
  };

  // Learner sign-in is handled by Supabase Auth in the app (Google OAuth and
  // phone OTP). The legacy /auth/otp/* and /auth/social endpoints were removed:
  // they minted server JWTs with a fixed development OTP and unverified
  // social-token audiences.

  // Staff Management Web Portal Login
  const StaffLoginSchema = z.object({
    identifier: z.string().trim().min(3).max(150),
    // Same minimum as account creation; shorter input cannot match an account.
    password: z.string().min(STAFF_PASSWORD_MIN_LENGTH).max(128),
  });

  app.post('/api/v1/staff/auth/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const parse = StaffLoginSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.errors[0].message });
    }

    const { password } = parse.data;
    const normalizedIdentifier = parse.data.identifier.toLowerCase();
    const loginFingerprint = createHash('sha256').update(`${normalizedIdentifier}|${req.ip}`).digest('hex');
    const rateCheck = await redis.checkRateLimit(`staff-login:${loginFingerprint}`, 8, 900);
    if (!rateCheck.allowed) {
      return reply.status(429).send({ error: 'Too many sign-in attempts. Wait 15 minutes before trying again.' });
    }

    let normalizedEmail = normalizedIdentifier;
    let userId: string | null = null;
    let staff: { role: StaffRole; name: string; managedAccount?: boolean; sessionVersion?: number } | null = null;
    try {
      const managedResult = await db.query(`SELECT id, email, username, full_name, role, password_hash, is_active,
          COALESCE(session_version, 1) AS session_version
        FROM public.staff_members WHERE lower(email)= $1 OR lower(username)= $1 LIMIT 2`, [normalizedIdentifier]);
      if ((managedResult.rowCount ?? 0) > 1) {
        burnStaffPasswordCheck(password);
        return reply.status(401).send({ error: 'Invalid staff credentials or unauthorized account' });
      }
      const managed = managedResult.rows[0];
      if (!managed) burnStaffPasswordCheck(password);
      if (managed) {
        if (!managed.is_active || !verifyStaffPassword(password, managed.password_hash)) {
          return reply.status(401).send({ error: 'Invalid staff credentials or unauthorized account' });
        }
        normalizedEmail = managed.email.toLowerCase();
        userId = managed.id;
        staff = { role: managed.role as StaffRole, name: managed.full_name, managedAccount: true, sessionVersion: Number(managed.session_version) || 1 };
      }
    } catch (err) {
      req.log.warn({ err }, 'Managed staff directory unavailable during sign-in');
    }

    if (!staff || !userId) return reply.status(401).send({ error: 'Invalid staff credentials or unauthorized account' });

    return issueManagedStaffSession(req, reply, {
      id: userId,
      email: normalizedEmail,
      name: staff.name,
      role: staff.role,
      sessionVersion: staff.sessionVersion || 1,
    }, 'password');
  });

  app.post('/api/v1/staff/auth/google', async (req: FastifyRequest, reply: FastifyReply) => {
    const loginFingerprint = createHash('sha256').update(req.ip).digest('hex');
    const rateCheck = await redis.checkRateLimit(`staff-google:${loginFingerprint}`, 8, 900);
    if (!rateCheck.allowed) {
      return reply.status(429).send({ error: 'Too many sign-in attempts. Wait 15 minutes before trying again.' });
    }

    const authorization = req.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) return reply.status(401).send({ error: 'Sign in with Google before requesting staff access.' });

    let identity;
    try {
      identity = await verifySupabaseAccessToken(match[1]);
    } catch (err) {
      if (err instanceof SupabaseAuthVerificationError) {
        return reply.status(err.statusCode).send({ error: err.message });
      }
      req.log.error({ err }, 'Google staff identity verification failed');
      return reply.status(503).send({ error: 'Staff sign-in is temporarily unavailable. Please try again.' });
    }

    const email = identity.email?.trim().toLowerCase();
    const providers = identity.app_metadata?.providers || [];
    if (!email || !identity.email_confirmed_at || !providers.includes('google')) {
      return reply.status(403).send({ error: 'This Google account is not authorized for staff access.' });
    }

    try {
      const managedResult = await db.query(`SELECT id, email, full_name, role,
          COALESCE(session_version, 1) AS session_version
        FROM public.staff_members
        WHERE lower(email)=$1 AND is_active=true LIMIT 2`, [email]);
      if (managedResult.rowCount !== 1) {
        return reply.status(403).send({ error: 'This Google account is not authorized for staff access.' });
      }
      const managed = managedResult.rows[0];
      return issueManagedStaffSession(req, reply, {
        id: managed.id,
        email: String(managed.email).toLowerCase(),
        name: managed.full_name,
        role: managed.role as StaffRole,
        sessionVersion: Number(managed.session_version) || 1,
      }, 'google');
    } catch (err) {
      req.log.error({ err }, 'Google staff account lookup failed');
      return reply.status(503).send({ error: 'Staff sign-in is temporarily unavailable. Please try again.' });
    }
  });

  app.post('/api/v1/staff/auth/logout', {
    preHandler: [requireStaffRole(['setter', 'moderator', 'scheduler', 'support', 'super_admin'])],
  }, async (req: any, reply) => {
    const sessionId = (req.staffUser as StaffJwtPayload).sessionId;
    const sessionKey = `staff:session:${createHash('sha256').update(sessionId).digest('hex')}`;
    const revoked = await redis.del(sessionKey);
    if (!revoked) return reply.status(503).send({ error: 'The staff session could not be revoked on the server.' });

    try {
      await db.query(`INSERT INTO public.staff_audit_logs
          (actor_email, actor_role, action, entity_type, entity_id, metadata)
        VALUES ($1,$2,'staff.session.revoked','staff_session',$3,$4::jsonb)`, [
        req.staffUser.email,
        req.staffUser.role,
        createHash('sha256').update(sessionId).digest('hex'),
        JSON.stringify({ scope: 'current_session' }),
      ]);
    } catch (err) {
      req.log.error({ err }, 'Staff session was revoked but audit logging failed');
    }
    return { success: true };
  });
};
