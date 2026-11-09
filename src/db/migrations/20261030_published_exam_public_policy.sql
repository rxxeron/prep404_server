-- Learner clients may browse only published active exams. Draft, cancelled,
-- and otherwise inactive exam records remain backend-only.
ALTER TABLE public.exams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Exams are viewable by everyone" ON public.exams;
CREATE POLICY "Published exams are viewable by everyone"
  ON public.exams FOR SELECT TO anon, authenticated
  USING (is_active = true AND COALESCE(is_draft, false) = false);
