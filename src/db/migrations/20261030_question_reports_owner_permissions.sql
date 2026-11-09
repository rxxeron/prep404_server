-- Learners may submit reports and read their own history, but moderation fields
-- and report lifecycle are controlled only by the authenticated backend.
ALTER TABLE public.question_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "question_reports_authenticated_owner_access" ON public.question_reports;
DROP POLICY IF EXISTS "question_reports_authenticated_owner_scope" ON public.question_reports;
DROP POLICY IF EXISTS "Learners can submit their own question reports" ON public.question_reports;
DROP POLICY IF EXISTS "Learners can read their own question reports" ON public.question_reports;

REVOKE ALL ON public.question_reports FROM anon, authenticated;
GRANT SELECT, INSERT ON public.question_reports TO authenticated;

CREATE POLICY "Learners can submit their own question reports"
  ON public.question_reports FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = reporter_id);
CREATE POLICY "Learners can read their own question reports"
  ON public.question_reports FOR SELECT TO authenticated
  USING (auth.uid() = reporter_id);
