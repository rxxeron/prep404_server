-- Track categories mirror active public.programs.track_category values.
-- Existing questions remain NULL because historical target tracks are unknown.
ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS target_track text;
ALTER TABLE public.questions
  DROP CONSTRAINT IF EXISTS questions_target_track_check;
ALTER TABLE public.questions
  ADD CONSTRAINT questions_target_track_check
  CHECK (target_track IS NULL OR target_track IN
    ('engineering', 'humanities', 'business', 'sciences', 'pharmacy', 'architecture', 'law'));
CREATE INDEX IF NOT EXISTS questions_target_track_review_idx
  ON public.questions (target_track, created_at DESC);
