-- Persist scheduler-created exam drafts without exposing them to candidates.
ALTER TABLE public.exams
  ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.exams
  ADD COLUMN IF NOT EXISTS draft_question_count SMALLINT;

DO $$ BEGIN
  ALTER TABLE public.exams
    ADD CONSTRAINT exams_draft_question_count_check
    CHECK (draft_question_count IS NULL OR draft_question_count BETWEEN 1 AND 200);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_exams_drafts_created
  ON public.exams(created_at DESC)
  WHERE is_draft = TRUE;
