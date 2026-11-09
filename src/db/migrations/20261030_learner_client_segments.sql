-- Store only coarse client context on consented app-open events.
-- Device/version/locale are bounded labels; user identity remains server-derived.
ALTER TABLE public.learner_analytics_events
  ADD COLUMN IF NOT EXISTS device_type TEXT,
  ADD COLUMN IF NOT EXISTS app_version TEXT,
  ADD COLUMN IF NOT EXISTS locale TEXT;

ALTER TABLE public.learner_analytics_events
  DROP CONSTRAINT IF EXISTS learner_analytics_events_device_type_check,
  DROP CONSTRAINT IF EXISTS learner_analytics_events_app_version_check,
  DROP CONSTRAINT IF EXISTS learner_analytics_events_locale_check;

ALTER TABLE public.learner_analytics_events
  ADD CONSTRAINT learner_analytics_events_device_type_check
    CHECK (device_type IS NULL OR device_type IN ('android','ios','web','other')),
  ADD CONSTRAINT learner_analytics_events_app_version_check
    CHECK (app_version IS NULL OR app_version ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(\+[0-9]{1,6})?$'),
  ADD CONSTRAINT learner_analytics_events_locale_check
    CHECK (locale IS NULL OR locale ~ '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$');

CREATE INDEX IF NOT EXISTS learner_analytics_events_device_day_idx
  ON public.learner_analytics_events (device_type, event_day)
  WHERE event_name = 'app_open';
CREATE INDEX IF NOT EXISTS learner_analytics_events_version_day_idx
  ON public.learner_analytics_events (app_version, event_day)
  WHERE event_name = 'app_open';
CREATE INDEX IF NOT EXISTS learner_analytics_events_locale_day_idx
  ON public.learner_analytics_events (locale, event_day)
  WHERE event_name = 'app_open';
