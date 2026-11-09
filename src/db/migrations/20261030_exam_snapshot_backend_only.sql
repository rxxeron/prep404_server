-- Snapshot payloads may contain answer keys for server-side scoring. Learner
-- delivery goes through the public exam API, which strips sensitive fields.
ALTER TABLE public.exam_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_exam_snapshots" ON public.exam_snapshots;
DROP POLICY IF EXISTS "Exam snapshots are viewable by everyone" ON public.exam_snapshots;
REVOKE ALL ON public.exam_snapshots FROM anon, authenticated;
