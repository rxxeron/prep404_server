import { FastifyRequest } from 'fastify';
import { SupabaseAuthVerificationError, verifySupabaseAccessToken } from './supabase_auth.service';

export type CandidateIdentityResult = {
  /** Verified learner ID, or null for an anonymous request. */
  userId: string | null;
  /** Set when a token was sent but could not be verified. */
  statusCode?: number;
  error?: string;
};

/**
 * Resolve the learner behind a request. No Authorization header means an
 * anonymous request; a header that does not verify is an error. Learner
 * identity comes only from Supabase Auth: server-signed JWTs are reserved for
 * staff sessions and are never accepted here.
 */
export async function resolveCandidateIdentity(req: FastifyRequest): Promise<CandidateIdentityResult> {
  const authorization = req.headers.authorization;
  if (authorization === undefined) return { userId: null };
  const accessToken = typeof authorization === 'string'
    ? authorization.match(/^Bearer\s+(.+)$/i)?.[1]
    : null;
  if (!accessToken) return { userId: null, statusCode: 401, error: 'Candidate session is invalid.' };
  try {
    const user = await verifySupabaseAccessToken(accessToken);
    return { userId: user.id };
  } catch (err) {
    const statusCode = err instanceof SupabaseAuthVerificationError ? err.statusCode : 503;
    const message = err instanceof Error ? err.message : 'Candidate identity verification is unavailable.';
    return { userId: null, statusCode, error: message };
  }
}
