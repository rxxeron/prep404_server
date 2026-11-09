-- Add immutable questions_snapshot JSONB to exam_submissions so every student attempt
-- retains its exact questions, scrambled option order, user choice, and verified solutions.
ALTER TABLE public.exam_submissions
  ADD COLUMN IF NOT EXISTS questions_snapshot JSONB;

COMMENT ON COLUMN public.exam_submissions.questions_snapshot IS
  'Immutable snapshot of questions, presented options order, solution explanations, and candidate selections for this specific attempt.';
