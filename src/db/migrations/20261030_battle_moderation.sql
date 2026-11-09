-- Persist authenticated human duels and route abuse reports through staff review.
CREATE TABLE IF NOT EXISTS public.battle_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_code VARCHAR(12) UNIQUE NOT NULL,
    battle_mode VARCHAR(20) DEFAULT '1v1',
    track VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'waiting',
    player_ids UUID[] NOT NULL,
    winner_id UUID REFERENCES public.users(id),
    round_scores JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_battle_rooms_status ON public.battle_rooms(status);
ALTER TABLE public.battle_rooms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.battle_rooms FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.battle_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    battle_id UUID NOT NULL REFERENCES public.battle_rooms(id) ON DELETE CASCADE,
    reporter_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    reported_player_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    category TEXT NOT NULL CHECK (category IN ('cheating','harassment','inappropriate_name','other')),
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','resolved','dismissed')),
    review_note TEXT,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (battle_id, reporter_id),
    CHECK (reported_player_id IS NULL OR reporter_id <> reported_player_id)
);
CREATE INDEX IF NOT EXISTS battle_reports_queue_idx ON public.battle_reports (status, created_at DESC);
ALTER TABLE public.battle_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.battle_reports FROM anon, authenticated;
