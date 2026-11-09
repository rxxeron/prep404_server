-- Additive admin workflow migration for the deployed Supabase schema.
-- Apply only after reviewing against the target environment.
ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS reviewed_by text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_notes text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_review_status_check') THEN
    ALTER TABLE public.questions ADD CONSTRAINT questions_review_status_check
      CHECK (review_status IN ('draft', 'under_review', 'approved', 'rejected', 'archived'));
  END IF;
END $$;

UPDATE public.questions SET review_status = 'archived' WHERE is_active = false AND review_status = 'approved';
CREATE INDEX IF NOT EXISTS questions_review_queue_idx
  ON public.questions (review_status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.staff_audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_email text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_audit_logs_created_at_idx
  ON public.staff_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS staff_audit_logs_entity_idx
  ON public.staff_audit_logs (entity_type, entity_id, created_at DESC);
ALTER TABLE public.staff_audit_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_audit_logs FROM anon, authenticated;

