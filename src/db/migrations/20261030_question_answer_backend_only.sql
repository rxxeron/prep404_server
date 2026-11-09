-- Question rows contain correct-option flags and explanations. Client access
-- must go through API serializers that omit answer keys until permitted.
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Active questions are viewable by everyone" ON public.questions;
DROP POLICY IF EXISTS "Questions are viewable by everyone" ON public.questions;
DROP POLICY IF EXISTS "Exam questions are viewable by everyone" ON public.exam_questions;

REVOKE ALL ON public.questions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.exam_questions FROM PUBLIC, anon, authenticated;
