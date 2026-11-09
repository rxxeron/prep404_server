-- Optional first-party learner analytics. Absence of a consent row means opted out.
CREATE TABLE IF NOT EXISTS public.learner_analytics_consent (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  policy_version TEXT NOT NULL DEFAULT '2026-10-v1',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.learner_analytics_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL CHECK (event_name IN ('analytics_consent_granted', 'app_open', 'onboarding_completed', 'practice_attempted', 'exam_submitted')),
  event_day DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '12 months'),
  CHECK (expires_at > occurred_at)
);
ALTER TABLE public.learner_analytics_events
  DROP CONSTRAINT IF EXISTS learner_analytics_events_event_name_check;
ALTER TABLE public.learner_analytics_events
  ADD CONSTRAINT learner_analytics_events_event_name_check
  CHECK (event_name IN ('analytics_consent_granted', 'app_open', 'onboarding_completed', 'practice_attempted', 'exam_submitted'));

CREATE INDEX IF NOT EXISTS learner_analytics_events_expiry_idx
  ON public.learner_analytics_events (expires_at);
CREATE INDEX IF NOT EXISTS learner_analytics_events_name_time_idx
  ON public.learner_analytics_events (event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS learner_analytics_events_user_stage_time_idx
  ON public.learner_analytics_events (user_id, event_name, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS learner_analytics_events_daily_open_idx
  ON public.learner_analytics_events (user_id, event_day)
  WHERE event_name = 'app_open';
CREATE UNIQUE INDEX IF NOT EXISTS learner_analytics_events_onboarding_once_idx
  ON public.learner_analytics_events (user_id)
  WHERE event_name = 'onboarding_completed';

ALTER TABLE public.learner_analytics_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learner_analytics_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.learner_analytics_consent FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.learner_analytics_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.learner_analytics_events_id_seq FROM PUBLIC, anon, authenticated;
