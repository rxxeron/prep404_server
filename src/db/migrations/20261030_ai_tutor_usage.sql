-- Non-identifying operational counters for the authored-hint tutor.
-- The table stores daily aggregates only: no learner IDs, question IDs, or response text.
CREATE TABLE IF NOT EXISTS public.ai_tutor_usage_daily (
  event_day DATE PRIMARY KEY DEFAULT (now() AT TIME ZONE 'UTC')::date,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  no_hint_count INTEGER NOT NULL DEFAULT 0 CHECK (no_hint_count >= 0),
  not_found_count INTEGER NOT NULL DEFAULT 0 CHECK (not_found_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  rate_limited_count INTEGER NOT NULL DEFAULT 0 CHECK (rate_limited_count >= 0),
  invalid_request_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_request_count >= 0),
  latency_total_ms BIGINT NOT NULL DEFAULT 0 CHECK (latency_total_ms >= 0),
  latency_max_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_max_ms >= 0),
  provider_cost_microusd BIGINT NOT NULL DEFAULT 0 CHECK (provider_cost_microusd >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_tutor_usage_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_tutor_usage_daily FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS ai_tutor_usage_daily_updated_idx
  ON public.ai_tutor_usage_daily (updated_at DESC);
