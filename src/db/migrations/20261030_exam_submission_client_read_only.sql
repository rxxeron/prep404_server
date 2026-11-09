-- Exam submissions contain authoritative scores and rankings. All writes go
-- through the identity-verified backend submission routes.
ALTER TABLE public.exam_submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "exam_submissions_authenticated_owner_access" ON public.exam_submissions;
DROP POLICY IF EXISTS "exam_submissions_authenticated_owner_scope" ON public.exam_submissions;
DROP POLICY IF EXISTS "Exam submissions are insertable by everyone" ON public.exam_submissions;
DROP POLICY IF EXISTS "Exam submissions are viewable by everyone" ON public.exam_submissions;

REVOKE ALL ON public.exam_submissions FROM anon, authenticated;
GRANT SELECT ON public.exam_submissions TO authenticated;

CREATE POLICY "Learners can read their own exam submissions"
  ON public.exam_submissions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
