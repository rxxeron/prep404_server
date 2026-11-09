export type VerifiedSupabaseUser = {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
  phone?: string;
  app_metadata?: {
    providers?: string[];
  };
  user_metadata?: Record<string, unknown>;
};

export class SupabaseAuthVerificationError extends Error {
  constructor(public readonly statusCode: 401 | 503, message: string) {
    super(message);
    this.name = 'SupabaseAuthVerificationError';
  }
}

/** Verify an access token against Supabase Auth rather than trusting decoded client claims. */
export async function verifySupabaseAccessToken(accessToken: string): Promise<VerifiedSupabaseUser> {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const publicApiKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !publicApiKey) {
    throw new SupabaseAuthVerificationError(503, 'Candidate identity verification is not configured.');
  }

  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: publicApiKey,
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new SupabaseAuthVerificationError(503, 'Candidate identity verification is temporarily unavailable.');
  }

  if (response.status === 401 || response.status === 403) {
    throw new SupabaseAuthVerificationError(401, 'Candidate session is invalid or expired.');
  }
  if (!response.ok) {
    throw new SupabaseAuthVerificationError(503, 'Candidate identity verification is temporarily unavailable.');
  }

  let user: VerifiedSupabaseUser;
  try {
    user = await response.json() as VerifiedSupabaseUser;
  } catch {
    throw new SupabaseAuthVerificationError(503, 'Candidate identity verification returned an invalid response.');
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id || '')) {
    throw new SupabaseAuthVerificationError(401, 'Candidate session does not contain a valid account identity.');
  }
  return user;
}
