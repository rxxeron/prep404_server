-- Senior Brother ("Bhaiya") AI Mentor Chat + Lab PC Fleet Load Balancer
-- Created: 2026-11-20

CREATE TABLE IF NOT EXISTS public.ai_fleet_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(64) NOT NULL UNIQUE,
  base_url TEXT NOT NULL UNIQUE,
  preferred_model VARCHAR(128) NOT NULL DEFAULT 'gemma4:12b',
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 50,
  max_concurrency INTEGER NOT NULL DEFAULT 2,
  last_status VARCHAR(24) NOT NULL DEFAULT 'unknown',
  last_latency_ms INTEGER,
  available_models JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Chat with Bhaiya',
  context_type VARCHAR(32) NOT NULL DEFAULT 'general',
  context_ref_id TEXT,
  context_payload JSONB,
  detected_language VARCHAR(16) NOT NULL DEFAULT 'en',
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_user_last
  ON public.ai_chat_sessions (user_id, last_message_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.ai_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.ai_chat_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  model_used VARCHAR(128),
  node_name VARCHAR(64),
  latency_ms INTEGER,
  feedback VARCHAR(16) CHECK (feedback IN ('up', 'down')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session_created
  ON public.ai_chat_messages (session_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_user_created
  ON public.ai_chat_messages (user_id, created_at DESC);

-- Seed the Prep404 Lab PC Cloudflare Tunnel fleet (labpc, labpc1..labpc35)
INSERT INTO public.ai_fleet_nodes (name, base_url, preferred_model, is_enabled, priority)
VALUES
  ('labpc',   'https://labpc.benchly.live',   'gemma4:12b', true, 50),
  ('labpc26', 'https://labpc26.benchly.live', 'gemma4:12b', true, 100)
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.ai_fleet_nodes (name, base_url, preferred_model, is_enabled, priority)
SELECT
  'labpc' || n::text,
  'https://labpc' || n::text || '.benchly.live',
  'gemma4:12b',
  true,
  50
FROM generate_series(1, 35) AS n
ON CONFLICT (name) DO NOTHING;

-- Enable Row Level Security
ALTER TABLE public.ai_fleet_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_chat_messages ENABLE ROW LEVEL SECURITY;

-- Policies for ai_chat_sessions (users only access their own sessions)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_chat_sessions' AND policyname = 'ai_chat_sessions_own_all'
  ) THEN
    CREATE POLICY ai_chat_sessions_own_all
      ON public.ai_chat_sessions
      FOR ALL
      TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- Policies for ai_chat_messages (users only access their own messages)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_chat_messages' AND policyname = 'ai_chat_messages_own_all'
  ) THEN
    CREATE POLICY ai_chat_messages_own_all
      ON public.ai_chat_messages
      FOR ALL
      TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;
