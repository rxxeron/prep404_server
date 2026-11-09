-- Restricted moderation queue for learner reports on tutor responses.
CREATE TABLE IF NOT EXISTS public.ai_response_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  question_id uuid REFERENCES public.questions(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('incorrect', 'unsafe', 'irrelevant', 'other')),
  response_text text NOT NULL CHECK (length(trim(response_text)) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved', 'dismissed')),
  resolution_note text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_response_reports_queue_idx
  ON public.ai_response_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_response_reports_question_idx
  ON public.ai_response_reports (question_id, created_at DESC)
  WHERE question_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_response_reports_unsafe_recent_idx
  ON public.ai_response_reports (created_at DESC, reporter_id)
  WHERE category = 'unsafe';
ALTER TABLE public.ai_response_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_response_reports FROM anon, authenticated;
