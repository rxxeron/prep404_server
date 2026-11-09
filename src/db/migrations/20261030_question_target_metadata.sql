-- Optional targeting metadata for institution- and language-aware question review.
ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS target_university_id UUID REFERENCES public.universities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'mixed';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='questions_language_check') THEN
    ALTER TABLE public.questions ADD CONSTRAINT questions_language_check
      CHECK (language IN ('bangla', 'english', 'mixed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS questions_target_university_language_idx
  ON public.questions (target_university_id, language, review_status, created_at DESC);
