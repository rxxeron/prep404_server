// Test helper: stands in for Supabase Auth's /auth/v1/user endpoint so route
// tests can present learner access tokens without a network call.
const TOKEN_PREFIX = 'test-supabase-learner:';

/** An access token the stub accepts as the given learner. */
export function learnerToken(userId: string): string {
  return `${TOKEN_PREFIX}${userId}`;
}

/**
 * Point SUPABASE_URL at a fake host and answer /auth/v1/user for tokens made by
 * learnerToken(). Every other token gets 401, like a real Auth server would.
 * Returns a function that restores fetch and the environment.
 */
export function installSupabaseAuthStub(): () => void {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL = 'https://supabase.example.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test_only';

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith('/auth/v1/user')) {
      throw new Error(`Unexpected fetch in test: ${url}`);
    }
    const headers = new Headers(init?.headers);
    const token = headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!token.startsWith(TOKEN_PREFIX)) {
      return new Response(JSON.stringify({ msg: 'invalid JWT' }), { status: 401 });
    }
    return new Response(JSON.stringify({ id: token.slice(TOKEN_PREFIX.length) }), { status: 200 });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = originalKey;
  };
}
