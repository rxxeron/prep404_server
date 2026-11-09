-- Additive columns required by the current exam submission routes.
-- Apply only after reviewing against the target environment.
ALTER TABLE public.exam_submissions
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(128),
  ADD COLUMN IF NOT EXISTS is_practice boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS candidate_name text,
  ADD COLUMN IF NOT EXISTS candidate_institution text,
  ADD COLUMN IF NOT EXISTS university_code text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_submissions_idempotency_key
  ON public.exam_submissions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
