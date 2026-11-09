import { FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';

export type StaffRole = 'setter' | 'moderator' | 'scheduler' | 'support' | 'super_admin';

export interface StaffJwtPayload {
  userId: string;
  email: string;
  role: StaffRole;
  sessionId: string;
  managedAccount?: boolean;
  sessionVersion?: number;
}

/**
 * Role-Based Access Control (RBAC) Guard for Prep404 Management APIs
 */
export function requireStaffRole(allowedRoles: StaffRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Missing or invalid staff authorization token' });
      }

      const decoded = await req.jwtVerify<StaffJwtPayload>();
      if (!decoded.sessionId || !decoded.userId || !decoded.email) {
        return reply.status(401).send({ error: 'Staff session is no longer valid. Sign in again.' });
      }
      const redis = (req.server as any).redisService;
      const sessionKey = `staff:session:${createHash('sha256').update(decoded.sessionId).digest('hex')}`;
      if (!redis || await redis.get(sessionKey) !== decoded.userId) {
        return reply.status(401).send({ error: 'Staff session was revoked or expired. Sign in again.' });
      }

      if (decoded.managedAccount) {
        const db = (req.server as any).db;
        if (!db) return reply.status(503).send({ error: 'Staff directory is unavailable.' });
        let current;
        try {
          current = await db.query(`SELECT role, is_active, COALESCE(session_version, 1) AS session_version
            FROM public.staff_members WHERE id=$1::uuid AND lower(email)=lower($2) LIMIT 1`, [decoded.userId, decoded.email]);
        } catch (err) {
          req.log.error({ err }, 'Managed staff session could not be verified');
          return reply.status(503).send({ error: 'Staff directory could not verify this session.' });
        }
        const account = current.rows[0];
        if (!account?.is_active || Number(account.session_version) !== Number(decoded.sessionVersion)) {
          return reply.status(401).send({ error: 'Staff account was disabled or its credentials changed. Sign in again.' });
        }
        decoded.role = account.role as StaffRole;
      }

      if (!decoded.role || !allowedRoles.includes(decoded.role)) {
        return reply.status(403).send({
          error: `Forbidden: role '${decoded.role}' lacks permission for this administrative action. Required: ${allowedRoles.join(', ')}`,
        });
      }

      (req as any).staffUser = decoded;
    } catch (err) {
      return reply.status(401).send({ error: 'Unauthorized staff session' });
    }
  };
}
