-- ============================================================================
-- Migration: Notification Infrastructure, Device Tokens, Inbox & Telemetry
-- ============================================================================

-- 1. Device Tokens
CREATE TABLE IF NOT EXISTS public.user_device_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    device_id VARCHAR(100) NOT NULL,
    fcm_token TEXT NOT NULL,
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
    app_version VARCHAR(20),
    is_active BOOLEAN DEFAULT true,
    subscribed_topics TEXT[] DEFAULT ARRAY['all', 'announcements'],
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_user_device UNIQUE (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_user_device_tokens_user ON public.user_device_tokens(user_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_user_device_tokens_platform ON public.user_device_tokens(platform);

-- 2. In-App Notification Center / Inbox
CREATE TABLE IF NOT EXISTS public.user_inbox_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    image_url TEXT,
    event_type VARCHAR(50) NOT NULL DEFAULT 'announcement',
    action_type VARCHAR(30) NOT NULL DEFAULT 'deep_link' CHECK (action_type IN ('app_open', 'deep_link', 'web_link')),
    target_route TEXT,
    external_url TEXT,
    is_read BOOLEAN DEFAULT false,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_inbox_user_read ON public.user_inbox_notifications(user_id, is_read, created_at DESC);

-- 3. Notification Tap & Interaction Telemetry
CREATE TABLE IF NOT EXISTS public.notification_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id TEXT NOT NULL,
    campaign_id TEXT,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    event VARCHAR(30) NOT NULL CHECK (event IN ('delivered', 'displayed', 'opened', 'action_clicked', 'dismissed')),
    action_id TEXT,
    app_state VARCHAR(20) CHECK (app_state IN ('foreground', 'background', 'terminated')),
    device_info JSONB DEFAULT '{}',
    occurred_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_events_campaign ON public.notification_events(campaign_id, event);
CREATE INDEX IF NOT EXISTS idx_notification_events_user ON public.notification_events(user_id);
