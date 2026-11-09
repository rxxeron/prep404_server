-- ==============================================================================
-- System Telemetry & Error Logging (High-Throughput Redis-Buffered Batch Table)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.app_system_logs (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    level VARCHAR(20) NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error', 'fatal', 'crash')),
    source VARCHAR(30) NOT NULL CHECK (source IN ('app', 'server', 'auth', 'exam', 'battle', 'network', 'system')),
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    event VARCHAR(100) NOT NULL,
    message TEXT,
    error_stack TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_logs_level_time ON public.app_system_logs (level, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_user_id ON public.app_system_logs (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_event ON public.app_system_logs (event, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_source ON public.app_system_logs (source, occurred_at DESC);

-- Restrict to backend service_role only (Learners and public cannot query raw logs)
ALTER TABLE public.app_system_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_system_logs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.app_system_logs_id_seq FROM PUBLIC, anon, authenticated;
