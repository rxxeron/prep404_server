CREATE TABLE IF NOT EXISTS public.exam_session_telemetry (
  session_hash CHAR(64) PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  exam_id UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('public', 'dynamic')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  failure_count SMALLINT NOT NULL DEFAULT 0 CHECK (failure_count BETWEEN 0 AND 100),
  last_failure_at TIMESTAMPTZ,
  last_failure_code TEXT CHECK (last_failure_code IN ('suspicious_speed', 'persistence_failed', 'request_failed')),
  CHECK (submitted_at IS NULL OR submitted_at >= started_at)
);
CREATE INDEX IF NOT EXISTS exam_session_telemetry_exam_started_idx
  ON public.exam_session_telemetry (exam_id, started_at DESC);
CREATE INDEX IF NOT EXISTS exam_session_telemetry_started_idx
  ON public.exam_session_telemetry (started_at);
ALTER TABLE public.exam_session_telemetry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_session_telemetry FROM anon, authenticated;
