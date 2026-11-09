-- ==============================================================================
-- User Study Streaks, Milestones & Timeline Ledger
-- ==============================================================================

CREATE TABLE IF NOT EXISTS user_streaks (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    current_streak INT NOT NULL DEFAULT 0,
    highest_streak INT NOT NULL DEFAULT 0,
    lowest_streak INT NOT NULL DEFAULT 0,
    total_active_days INT NOT NULL DEFAULT 0,
    total_streak_cycles INT NOT NULL DEFAULT 0,
    streak_freezes_available INT NOT NULL DEFAULT 1,
    streak_freezes_used INT NOT NULL DEFAULT 0,
    last_active_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_streaks_user ON user_streaks(user_id);

CREATE TABLE IF NOT EXISTS user_streak_timeline (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    days_count INT NOT NULL DEFAULT 1,
    questions_solved INT NOT NULL DEFAULT 0,
    exams_completed INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    used_freeze BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_streak_timeline_user ON user_streak_timeline(user_id, start_date DESC);

CREATE TABLE IF NOT EXISTS user_daily_activity (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    activity_date DATE NOT NULL,
    questions_solved INT NOT NULL DEFAULT 0,
    exams_completed INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, activity_date)
);

CREATE INDEX IF NOT EXISTS idx_user_daily_activity_user ON user_daily_activity(user_id, activity_date DESC);

-- Enable Row Level Security
ALTER TABLE user_streaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_streak_timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_daily_activity ENABLE ROW LEVEL SECURITY;

-- Select policies for authenticated users
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'user_streaks' AND policyname = 'Users can read own streaks'
    ) THEN
        CREATE POLICY "Users can read own streaks" ON user_streaks
            FOR SELECT TO authenticated USING (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'user_streak_timeline' AND policyname = 'Users can read own streak timeline'
    ) THEN
        CREATE POLICY "Users can read own streak timeline" ON user_streak_timeline
            FOR SELECT TO authenticated USING (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'user_daily_activity' AND policyname = 'Users can read own daily activity'
    ) THEN
        CREATE POLICY "Users can read own daily activity" ON user_daily_activity
            FOR SELECT TO authenticated USING (auth.uid() = user_id);
    END IF;
END $$;
