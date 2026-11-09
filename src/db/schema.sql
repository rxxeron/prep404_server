-- ============================================================================
-- Prep404 Enterprise Database Schema (PostgreSQL 15+)
-- Optimized for High-Concurrency Competitive Exams & Private Uni Admissions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. CANDIDATES & USERS (Supports Bangla/English Medium & Target Selections)
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) UNIQUE,                          -- Nullable until linked
    email VARCHAR(150) UNIQUE,
    google_id VARCHAR(100) UNIQUE,
    facebook_id VARCHAR(100) UNIQUE,
    avatar_url TEXT,
    full_name VARCHAR(100) NOT NULL,
    medium VARCHAR(20) DEFAULT 'bangla',               -- 'bangla', 'english'
    english_curriculum VARCHAR(20),                    -- 'cambridge', 'edexcel', or NULL
    academic_batch VARCHAR(30) DEFAULT 'HSC 24',       -- "HSC '24", "A-Level '24", etc.
    institution_name VARCHAR(150),                     -- College or School name
    institution_eiin VARCHAR(20),
    institution_id UUID,
    gender VARCHAR(20),                                -- 'male', 'female', 'other'
    division_id VARCHAR(50),
    division_name VARCHAR(100),
    district_id VARCHAR(50),
    district_name VARCHAR(100),
    nctb_version VARCHAR(20),                          -- 'bangla', 'english'
    ssc_group VARCHAR(50),
    ssc_year VARCHAR(10),
    ssc_gpa VARCHAR(10),
    ssc_institution VARCHAR(255),
    ssc_eiin VARCHAR(20),
    hsc_group VARCHAR(50),
    hsc_batch VARCHAR(30),
    hsc_gpa VARCHAR(30),
    hsc_institution VARCHAR(255),
    hsc_eiin VARCHAR(20),
    target_universities JSONB DEFAULT '[]',            -- Array of target codes: ["NSU", "BRACU", "IUB"]
    target_disciplines JSONB DEFAULT '{}',             -- {"nsu": ["nsu_cse", "nsu_bba"], "brac": ["brac_cse"]}
    track VARCHAR(50) DEFAULT 'private_uni',           -- 'private_uni', 'bcs', 'medical', 'varsity'
    total_xp INT DEFAULT 0,
    current_league VARCHAR(20) DEFAULT 'ALPHA',        -- ALPHA, BETA, GAMMA, THETA, LAMBDA, SIGMA, OMEGA
    streak_days INT DEFAULT 1,
    coins INT DEFAULT 100,
    is_premium BOOLEAN DEFAULT FALSE,
    fcm_token TEXT,
    last_login_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_facebook_id ON users(facebook_id);
CREATE INDEX IF NOT EXISTS idx_users_xp_league ON users(total_xp DESC, current_league);
CREATE INDEX IF NOT EXISTS idx_users_track ON users(track);
CREATE INDEX IF NOT EXISTS idx_users_target_unis ON users USING gin(target_universities);

-- ============================================================================
-- 2. PRIVATE UNIVERSITIES & DISCIPLINES CATALOG (Target: Pure UUID Relations)
-- Defined in schema_private_universities.sql:
-- - public.universities
-- - public.academic_units
-- - public.programs
-- - public.program_fee_structures
-- - public.admission_test_patterns
-- - public.program_pattern_mappings
-- - public.admission_cycles
-- ============================================================================

-- ============================================================================
-- 3. LEAGUE TIERS METADATA (7 Greek Tiers)
-- ============================================================================
CREATE TABLE IF NOT EXISTS leagues (
    tier_name VARCHAR(20) PRIMARY KEY,
    min_xp INT NOT NULL,
    max_xp INT NOT NULL,
    color_hex VARCHAR(10) NOT NULL,
    promotion_cutoff_percentile FLOAT DEFAULT 0.20,
    relegation_cutoff_percentile FLOAT DEFAULT 0.20
);

INSERT INTO leagues (tier_name, min_xp, max_xp, color_hex) VALUES
('ALPHA', 1, 1000, '#6B7280'),
('BETA', 1001, 2000, '#10B981'),
('GAMMA', 2001, 3000, '#3B82F6'),
('THETA', 3001, 4000, '#8B5CF6'),
('LAMBDA', 4001, 5000, '#EC4899'),
('SIGMA', 5001, 8000, '#F59E0B'),
('OMEGA', 8001, 13000, '#EF4444')
ON CONFLICT (tier_name) DO NOTHING;

-- ============================================================================
-- 4. CURRICULUM HIERARCHY (Subjects & Topics)
-- ============================================================================
CREATE TABLE IF NOT EXISTS subjects (
    id VARCHAR(50) PRIMARY KEY,
    track VARCHAR(50) NOT NULL,                        -- 'private_uni', 'bcs', etc.
    title VARCHAR(100) NOT NULL,
    icon_url TEXT,
    display_order INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS topics (
    id VARCHAR(50) PRIMARY KEY,
    subject_id VARCHAR(50) REFERENCES subjects(id) ON DELETE CASCADE,
    title VARCHAR(120) NOT NULL,
    total_questions INT DEFAULT 0,
    is_free BOOLEAN DEFAULT TRUE,
    display_order INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_topics_subject ON topics(subject_id);

-- ============================================================================
-- 5. STAFF & MANAGEMENT (Question Setters, Moderators, Schedulers)
-- ============================================================================
CREATE TABLE IF NOT EXISTS staff_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(150) UNIQUE NOT NULL,
    username VARCHAR(32) NOT NULL CHECK (username ~ '^[a-z0-9_]{3,32}$'),
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role VARCHAR(30) NOT NULL DEFAULT 'setter' CHECK (role IN ('super_admin', 'setter', 'moderator', 'scheduler', 'support')),
    assigned_subjects TEXT[] DEFAULT '{}',
    is_active BOOLEAN DEFAULT TRUE,
    session_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.staff_members ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.staff_members DROP CONSTRAINT IF EXISTS staff_members_role_check;
ALTER TABLE public.staff_members ADD CONSTRAINT staff_members_role_check
    CHECK (role IN ('super_admin', 'setter', 'moderator', 'scheduler', 'support'));
CREATE UNIQUE INDEX IF NOT EXISTS staff_members_email_lower_uidx ON public.staff_members (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS staff_members_username_lower_uidx ON public.staff_members (lower(username));

-- ============================================================================
-- 5.1 QUESTION BANK WITH KATEX MATH & SOCRATIC HINTS
-- ============================================================================
CREATE TABLE IF NOT EXISTS questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id VARCHAR(50) REFERENCES subjects(id) ON DELETE CASCADE,
    topic_id VARCHAR(50) REFERENCES topics(id) ON DELETE CASCADE,
    setter_id UUID REFERENCES staff_members(id) ON DELETE SET NULL,
    moderator_id UUID REFERENCES staff_members(id) ON DELETE SET NULL,
    status VARCHAR(20) DEFAULT 'approved' CHECK (status IN ('draft', 'under_review', 'approved', 'rejected')),
    question_text TEXT NOT NULL,                       -- Markdown + KaTeX (e.g. $\int_0^{\pi} \sin(x) dx$)
    has_math BOOLEAN DEFAULT FALSE,
    options JSONB NOT NULL,                            -- Array: [{"id": "A", "text": "...", "has_math": false}]
    correct_option VARCHAR(5) NOT NULL,
    explanation TEXT NOT NULL,                         -- Complete step-by-step resolution
    hints JSONB DEFAULT '[]',                          -- Socratic progressive hint array: ["Hint 1", "Hint 2"]
    difficulty_rating FLOAT DEFAULT 1.0,
    target_universities TEXT[] DEFAULT '{}',           -- Array: ['NSU', 'BRACU', 'IUB']
    target_categories TEXT[] DEFAULT '{}',             -- Array: ['engineering', 'business']
    exam_appearances TEXT[] DEFAULT '{}',              -- e.g. ['NSU Fall 2023', 'BRAC Spring 2024']
    target_university_id UUID REFERENCES public.universities(id) ON DELETE SET NULL,
    target_track TEXT CHECK (target_track IS NULL OR target_track IN ('engineering', 'humanities', 'business', 'sciences', 'pharmacy', 'architecture', 'law')),
    language TEXT NOT NULL DEFAULT 'mixed' CHECK (language IN ('bangla', 'english', 'mixed')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_questions_topic ON questions(topic_id);
CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions(subject_id);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_target_unis ON questions USING gin(target_universities);
CREATE INDEX IF NOT EXISTS idx_questions_categories ON questions USING gin(target_categories);

-- ============================================================================
-- 6. EXAMS, DAILY MODEL TESTS & SHAREABLE LINKS
-- ============================================================================
CREATE TABLE IF NOT EXISTS exams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(100) UNIQUE,                          -- e.g. 'daily-model-test-24' for shareable links
    short_code VARCHAR(12) UNIQUE,                     -- e.g. 'dmt24'
    title VARCHAR(200) NOT NULL,
    track VARCHAR(50) NOT NULL,                        -- 'private_uni', 'bcs'
    target_university_id UUID REFERENCES universities(id) ON DELETE SET NULL,
    exam_type VARCHAR(50) NOT NULL DEFAULT 'daily',    -- 'daily', 'live', 'model_test', 'routine', 'druto'
    duration_seconds INT NOT NULL CHECK (duration_seconds BETWEEN 60 AND 36000),
    total_marks FLOAT NOT NULL CHECK (total_marks > 0 AND total_marks <= 2000),
    negative_mark_per_question FLOAT DEFAULT 0.25
        CHECK (negative_mark_per_question IS NULL OR (
            negative_mark_per_question >= 0
            AND negative_mark_per_question <= 100
            AND negative_mark_per_question <= total_marks
        )), -- Standard private uni: 0.25 (or 0 for NSU general)
    starts_at TIMESTAMP WITH TIME ZONE,
    ends_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    is_draft BOOLEAN NOT NULL DEFAULT FALSE,
    draft_question_count SMALLINT CHECK (draft_question_count IS NULL OR draft_question_count BETWEEN 1 AND 200),
    is_public_link BOOLEAN DEFAULT TRUE,
    og_title VARCHAR(200),
    og_description TEXT,
    og_banner_url TEXT,
    created_by UUID REFERENCES staff_members(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.exams
    ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.exams
    ADD COLUMN IF NOT EXISTS draft_question_count SMALLINT;

CREATE INDEX IF NOT EXISTS idx_exams_active_track ON exams(track, is_active, starts_at);
CREATE INDEX IF NOT EXISTS idx_exams_slug ON exams(slug);
CREATE INDEX IF NOT EXISTS idx_exams_short_code ON exams(short_code);

CREATE TABLE IF NOT EXISTS exam_questions (
    exam_id UUID REFERENCES exams(id) ON DELETE CASCADE,
    question_id UUID REFERENCES questions(id) ON DELETE CASCADE,
    question_order INT NOT NULL,
    PRIMARY KEY (exam_id, question_id)
);

CREATE TABLE IF NOT EXISTS exam_link_clicks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    utm_source VARCHAR(50) DEFAULT 'direct',           -- 'whatsapp', 'facebook', 'direct'
    clicked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_link_clicks_exam ON exam_link_clicks(exam_id, utm_source);

-- ============================================================================
-- 7. EXAM SUBMISSIONS & PERFORMANCE
-- ============================================================================
CREATE TABLE IF NOT EXISTS exam_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID REFERENCES exams(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    answers JSONB NOT NULL,                            -- {"q_id": "opt_A", ...}
    score FLOAT NOT NULL,
    correct_count INT NOT NULL,
    wrong_count INT NOT NULL,
    unanswered_count INT NOT NULL,
    time_taken_seconds INT NOT NULL,
    rank INT,
    is_practice BOOLEAN NOT NULL DEFAULT FALSE,
    candidate_name TEXT,
    candidate_institution TEXT,
    university_code TEXT,
    questions_snapshot JSONB,
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE exam_submissions
    ADD COLUMN IF NOT EXISTS questions_snapshot JSONB,
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128),
    ADD COLUMN IF NOT EXISTS is_practice BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS candidate_name TEXT,
    ADD COLUMN IF NOT EXISTS candidate_institution TEXT,
    ADD COLUMN IF NOT EXISTS university_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_submissions_idempotency_key
    ON exam_submissions(idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_submissions_user_ranked
    ON exam_submissions (exam_id, user_id)
    WHERE is_practice = false;

CREATE INDEX IF NOT EXISTS idx_submissions_exam_score ON exam_submissions(exam_id, score DESC, time_taken_seconds ASC);
CREATE INDEX IF NOT EXISTS idx_submissions_user ON exam_submissions(user_id);

-- Durable, server-scored per-question outcomes for subject/topic reporting.
CREATE TABLE IF NOT EXISTS public.exam_submission_answers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    submission_id UUID NOT NULL REFERENCES public.exam_submissions(id) ON DELETE CASCADE,
    question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
    subject_id UUID,
    topic_id UUID,
    selected_option TEXT,
    correct_option TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('correct', 'wrong', 'skipped')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (submission_id, question_id)
);
CREATE INDEX IF NOT EXISTS exam_submission_answers_topic_idx
    ON public.exam_submission_answers (topic_id, submission_id);
CREATE INDEX IF NOT EXISTS exam_submission_answers_subject_idx
    ON public.exam_submission_answers (subject_id, submission_id);
CREATE INDEX IF NOT EXISTS exam_submissions_nonpractice_submitted_at_idx
    ON public.exam_submissions (submitted_at DESC)
    WHERE is_practice = false;
ALTER TABLE public.exam_submission_answers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_submission_answers FROM anon, authenticated;

-- ============================================================================
-- 8. FSRS SPACED REPETITION MEMORY STATE (Continuous Concept Retention)
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_practice_progress (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    topic_id VARCHAR(50) REFERENCES topics(id) ON DELETE CASCADE,
    mastery_level INT DEFAULT 0,                       -- 0..3 stars
    total_attempts INT DEFAULT 0,
    accuracy_rate FLOAT DEFAULT 0.0,
    fsrs_stability FLOAT DEFAULT 1.0,                  -- Memory stability in days
    fsrs_difficulty FLOAT DEFAULT 5.0,                 -- Difficulty 1..10
    due_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_reviewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, topic_id)
);

CREATE INDEX IF NOT EXISTS idx_practice_user_due ON user_practice_progress(user_id, due_date);

CREATE TABLE IF NOT EXISTS public.practice_attempts (
    attempt_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
    subject_id UUID,
    topic_id UUID,
    selected_option_id TEXT NOT NULL CHECK (length(selected_option_id) BETWEEN 1 AND 20),
    is_correct BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS practice_attempts_created_idx ON public.practice_attempts (created_at DESC);
CREATE INDEX IF NOT EXISTS practice_attempts_topic_created_idx ON public.practice_attempts (topic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS practice_attempts_user_created_idx ON public.practice_attempts (user_id, created_at DESC);
ALTER TABLE public.practice_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.practice_attempts FROM PUBLIC, anon, authenticated;

-- Learner support requests are only accessed through the authenticated backend API.
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
CREATE INDEX IF NOT EXISTS exam_session_telemetry_exam_started_idx ON public.exam_session_telemetry (exam_id, started_at DESC);
CREATE INDEX IF NOT EXISTS exam_session_telemetry_started_idx ON public.exam_session_telemetry (started_at);
ALTER TABLE public.exam_session_telemetry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_session_telemetry FROM anon, authenticated;

-- Optional first-party learner analytics. Defaults to enabled (on by default).
CREATE TABLE IF NOT EXISTS public.learner_analytics_consent (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT true,
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
    device_type TEXT CHECK (device_type IS NULL OR device_type IN ('android','ios','web','other')),
    app_version TEXT CHECK (app_version IS NULL OR app_version ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(\+[0-9]{1,6})?$'),
    locale TEXT CHECK (locale IS NULL OR locale ~ '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$'),
    CHECK (expires_at > occurred_at)
);
CREATE INDEX IF NOT EXISTS learner_analytics_events_expiry_idx ON public.learner_analytics_events (expires_at);
CREATE INDEX IF NOT EXISTS learner_analytics_events_name_time_idx ON public.learner_analytics_events (event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS learner_analytics_events_user_stage_time_idx ON public.learner_analytics_events (user_id, event_name, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS learner_analytics_events_daily_open_idx ON public.learner_analytics_events (user_id, event_day) WHERE event_name='app_open';
CREATE INDEX IF NOT EXISTS learner_analytics_events_device_day_idx ON public.learner_analytics_events (device_type, event_day) WHERE event_name='app_open';
CREATE INDEX IF NOT EXISTS learner_analytics_events_version_day_idx ON public.learner_analytics_events (app_version, event_day) WHERE event_name='app_open';
CREATE INDEX IF NOT EXISTS learner_analytics_events_locale_day_idx ON public.learner_analytics_events (locale, event_day) WHERE event_name='app_open';
CREATE UNIQUE INDEX IF NOT EXISTS learner_analytics_events_onboarding_once_idx ON public.learner_analytics_events (user_id) WHERE event_name='onboarding_completed';
ALTER TABLE public.learner_analytics_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learner_analytics_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.learner_analytics_consent FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.learner_analytics_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.learner_analytics_events_id_seq FROM PUBLIC, anon, authenticated;

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
CREATE INDEX IF NOT EXISTS ai_tutor_usage_daily_updated_idx ON public.ai_tutor_usage_daily (updated_at DESC);

CREATE TABLE IF NOT EXISTS public.learner_support_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    idempotency_key UUID,
    category TEXT NOT NULL CHECK (category IN ('account_access', 'profile_update', 'learning_progress', 'exam_access', 'other')),
    subject TEXT NOT NULL CHECK (length(trim(subject)) BETWEEN 5 AND 120),
    message TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 10 AND 2000),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    staff_note TEXT,
    updated_by TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS learner_support_requests_queue_idx
    ON public.learner_support_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS learner_support_requests_requester_idx
    ON public.learner_support_requests (requester_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS learner_support_request_idempotency_uidx
    ON public.learner_support_requests (requester_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
ALTER TABLE public.learner_support_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.learner_support_requests FROM anon, authenticated;

-- Restricted moderation queue for learner reports on tutor responses.
CREATE TABLE IF NOT EXISTS public.ai_response_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    question_id UUID REFERENCES public.questions(id) ON DELETE SET NULL,
    category TEXT NOT NULL CHECK (category IN ('incorrect', 'unsafe', 'irrelevant', 'other')),
    response_text TEXT NOT NULL CHECK (length(trim(response_text)) BETWEEN 1 AND 4000),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved', 'dismissed')),
    resolution_note TEXT,
    resolved_by TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_response_reports_queue_idx
    ON public.ai_response_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_response_reports_question_idx
    ON public.ai_response_reports (question_id, created_at DESC)
    WHERE question_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_response_reports_unsafe_recent_idx
    ON public.ai_response_reports (created_at DESC, reporter_id)
    WHERE category = 'unsafe';
ALTER TABLE public.ai_response_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_response_reports FROM anon, authenticated;

-- ============================================================================
-- 9. REAL-TIME BATTLE ROOMS (1v1 & SQUADS)
-- ============================================================================
CREATE TABLE IF NOT EXISTS battle_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_code VARCHAR(12) UNIQUE NOT NULL,
    battle_mode VARCHAR(20) DEFAULT '1v1',             -- '1v1', 'squad'
    track VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'waiting',              -- 'waiting', 'in_progress', 'finished'
    player_ids UUID[] NOT NULL,
    winner_id UUID REFERENCES users(id),
    round_scores JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_battle_rooms_status ON battle_rooms(status);
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
