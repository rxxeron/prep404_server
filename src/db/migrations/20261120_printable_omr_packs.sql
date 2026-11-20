-- Printable OMR Practice Packs (with QR code set resolution) and Offline Practice Attempts
-- Created: 2026-11-20

CREATE TABLE IF NOT EXISTS public.printable_omr_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code VARCHAR(16) NOT NULL UNIQUE,
  exam_id UUID REFERENCES public.exams(id) ON DELETE SET NULL,
  user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  university_code VARCHAR(24),
  set_label VARCHAR(16) NOT NULL DEFAULT 'SET-A',
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  negative_mark NUMERIC(4,2) NOT NULL DEFAULT 0.00,
  total_questions INTEGER NOT NULL,
  question_snapshot JSONB NOT NULL,
  answer_key JSONB NOT NULL,
  scan_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_printable_omr_sets_short_code
  ON public.printable_omr_sets (short_code);

CREATE INDEX IF NOT EXISTS idx_printable_omr_sets_user_created
  ON public.printable_omr_sets (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_printable_omr_sets_exam_id
  ON public.printable_omr_sets (exam_id);

CREATE TABLE IF NOT EXISTS public.printable_omr_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  omr_set_id UUID NOT NULL REFERENCES public.printable_omr_sets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  correct_count INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  score NUMERIC(8,2) NOT NULL DEFAULT 0,
  total_questions INTEGER NOT NULL,
  accuracy_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  time_spent_minutes INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_printable_omr_attempts_user_created
  ON public.printable_omr_attempts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_printable_omr_attempts_set_user
  ON public.printable_omr_attempts (omr_set_id, user_id, created_at DESC);

-- Enable Row Level Security
ALTER TABLE public.printable_omr_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.printable_omr_attempts ENABLE ROW LEVEL SECURITY;

-- Policies for printable_omr_sets
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'printable_omr_sets' AND policyname = 'printable_omr_sets_read_authenticated'
  ) THEN
    CREATE POLICY printable_omr_sets_read_authenticated
      ON public.printable_omr_sets
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'printable_omr_sets' AND policyname = 'printable_omr_sets_insert_own'
  ) THEN
    CREATE POLICY printable_omr_sets_insert_own
      ON public.printable_omr_sets
      FOR INSERT
      TO authenticated
      WITH CHECK (user_id IS NULL OR user_id = auth.uid());
  END IF;
END $$;

-- Policies for printable_omr_attempts
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'printable_omr_attempts' AND policyname = 'printable_omr_attempts_select_own'
  ) THEN
    CREATE POLICY printable_omr_attempts_select_own
      ON public.printable_omr_attempts
      FOR SELECT
      TO authenticated
      USING (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'printable_omr_attempts' AND policyname = 'printable_omr_attempts_insert_own'
  ) THEN
    CREATE POLICY printable_omr_attempts_insert_own
      ON public.printable_omr_attempts
      FOR INSERT
      TO authenticated
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;
