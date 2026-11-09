-- Authenticated learner question reports with staff-only moderation through the backend.
CREATE TABLE IF NOT EXISTS public.question_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('incorrect_answer', 'typo', 'unclear', 'missing_explanation', 'other')),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 5 AND 500),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved', 'dismissed')),
  resolution_note text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS question_reports_queue_idx
  ON public.question_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS question_reports_question_idx
  ON public.question_reports (question_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS question_reports_one_open_per_reporter_idx
  ON public.question_reports (question_id, reporter_id)
  WHERE status IN ('open', 'in_review');

ALTER TABLE public.question_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.question_reports FROM anon;
GRANT SELECT, INSERT ON public.question_reports TO authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='question_reports' AND policyname='Learners can submit their own question reports') THEN
    CREATE POLICY "Learners can submit their own question reports" ON public.question_reports
      FOR INSERT TO authenticated WITH CHECK (auth.uid() = reporter_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='question_reports' AND policyname='Learners can read their own question reports') THEN
    CREATE POLICY "Learners can read their own question reports" ON public.question_reports
      FOR SELECT TO authenticated USING (auth.uid() = reporter_id);
  END IF;
END $$;

