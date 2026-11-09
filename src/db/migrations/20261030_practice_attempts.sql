-- Server-scored practice outcomes. No answer text or client-claimed accuracy is stored.
CREATE TABLE IF NOT EXISTS public.practice_attempts (
  attempt_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  subject_id UUID,
  topic_id UUID,
  selected_option_id TEXT NOT NULL CHECK (length(selected_option_id) BETWEEN 1 AND 20),
  is_correct BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS practice_attempts_created_idx ON public.practice_attempts (created_at DESC);
CREATE INDEX IF NOT EXISTS practice_attempts_topic_created_idx ON public.practice_attempts (topic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS practice_attempts_user_created_idx ON public.practice_attempts (user_id, created_at DESC);
ALTER TABLE public.practice_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.practice_attempts FROM PUBLIC, anon, authenticated;
