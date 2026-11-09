-- Private learner support intake. All access goes through the authenticated API;
-- direct Supabase Data API access is explicitly disabled for client roles.
CREATE TABLE IF NOT EXISTS public.learner_support_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('account_access', 'profile_update', 'learning_progress', 'exam_access', 'other')),
  subject text NOT NULL CHECK (length(trim(subject)) BETWEEN 5 AND 120),
  message text NOT NULL CHECK (length(trim(message)) BETWEEN 10 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  staff_note text,
  updated_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS learner_support_requests_queue_idx
  ON public.learner_support_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS learner_support_requests_requester_idx
  ON public.learner_support_requests (requester_id, created_at DESC);
ALTER TABLE public.learner_support_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.learner_support_requests FROM anon, authenticated;

