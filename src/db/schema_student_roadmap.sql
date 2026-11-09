-- ============================================================================
-- Prep404 Student Roadmaps & University Success Engine
-- PostgreSQL Schema & RPC Functions for Individual Student Progress
-- ============================================================================

-- 1. UNIVERSITY ADMISSION BLUEPRINTS
CREATE TABLE IF NOT EXISTS university_blueprints (
    id VARCHAR(50) PRIMARY KEY,                       -- e.g. 'iub_sets', 'brac_cse', 'nsu_seps'
    university_code VARCHAR(20) NOT NULL,             -- 'IUB', 'BRAC', 'NSU', 'AUST', 'UIU'
    program_title VARCHAR(150) NOT NULL,              -- e.g. 'School of Engineering, Technology & Sciences'
    degree_name VARCHAR(100) NOT NULL,                -- 'CSE / EEE / ETE'
    total_marks FLOAT NOT NULL DEFAULT 100,
    duration_minutes INT NOT NULL DEFAULT 90,
    negative_marking FLOAT NOT NULL DEFAULT 0.25,
    cutoff_target_percentage FLOAT NOT NULL DEFAULT 80.0,
    sections JSONB NOT NULL,                          -- Array: [{"id": "eng", "title": "English", "marks": 30, "weight": 0.30}, ...]
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed Default Blueprints
INSERT INTO university_blueprints (id, university_code, program_title, degree_name, total_marks, duration_minutes, negative_marking, cutoff_target_percentage, sections)
VALUES 
(
    'iub_sets',
    'iub',
    'SETS Engineering Unit',
    'CSE, EEE, Computer Engineering',
    100.0,
    90,
    0.25,
    80.0,
    '[
        {"id": "eng", "title": "English Comprehension & Vocab", "marks": 30, "weight": 0.30, "color_hex": "#6366F1"},
        {"id": "gen_math", "title": "General Mathematics", "marks": 30, "weight": 0.30, "color_hex": "#06B6D4"},
        {"id": "high_math", "title": "Higher Mathematics", "marks": 20, "weight": 0.20, "color_hex": "#F59E0B"},
        {"id": "phy", "title": "Physics for SETS", "marks": 20, "weight": 0.20, "color_hex": "#EF4444"}
    ]'::jsonb
),
(
    'brac_cse',
    'brac',
    'School of Data & Sciences',
    'Computer Science & Engineering',
    50.0,
    60,
    0.25,
    85.0,
    '[
        {"id": "eng", "title": "English Grammar & Reading", "marks": 20, "weight": 0.40, "color_hex": "#10B981"},
        {"id": "math", "title": "Higher Mathematics", "marks": 20, "weight": 0.40, "color_hex": "#3B82F6"},
        {"id": "phy", "title": "Physics Mechanics & Electricity", "marks": 10, "weight": 0.20, "color_hex": "#F59E0B"}
    ]'::jsonb
),
(
    'nsu_seps',
    'nsu',
    'School of Engineering & Physical Sciences',
    'CSE, EEE, Civil Engineering',
    100.0,
    120,
    0.0,
    75.0,
    '[
        {"id": "eng", "title": "General English", "marks": 30, "weight": 0.30, "color_hex": "#3B82F6"},
        {"id": "quant_math", "title": "Quantitative Math", "marks": 30, "weight": 0.30, "color_hex": "#10B981"},
        {"id": "high_math", "title": "Higher Math", "marks": 25, "weight": 0.25, "color_hex": "#F59E0B"},
        {"id": "science", "title": "Science & Mechanics", "marks": 15, "weight": 0.15, "color_hex": "#8B5CF6"}
    ]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- 2. STUDENT SECTION-WISE PROGRESS
CREATE TABLE IF NOT EXISTS student_section_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    university_code VARCHAR(20) NOT NULL,
    section_id VARCHAR(50) NOT NULL,
    mastery_percentage FLOAT NOT NULL DEFAULT 0.0,
    questions_attempted INT NOT NULL DEFAULT 0,
    correct_count INT NOT NULL DEFAULT 0,
    last_practiced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user_id, university_code, section_id)
);

CREATE INDEX IF NOT EXISTS idx_student_sec_prog ON student_section_progress(user_id, university_code);

-- 3. STUDENT HIKING TRAIL CHECKPOINT PROGRESS
CREATE TABLE IF NOT EXISTS student_milestone_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    university_code VARCHAR(20) NOT NULL,
    node_id VARCHAR(50) NOT NULL,                     -- 'basecamp', 'camp_02', 'camp_03', 'camp_04', 'summit'
    status VARCHAR(20) NOT NULL DEFAULT 'locked',     -- 'completed', 'active', 'locked'
    score_percentage FLOAT,
    unlocked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    UNIQUE (user_id, university_code, node_id)
);

CREATE INDEX IF NOT EXISTS idx_student_milestones ON student_milestone_progress(user_id, university_code);

-- 4. MISTAKE VAULT (ভুল উত্তরের খাতা) WITH FSRS SPACED REPETITION
CREATE TABLE IF NOT EXISTS mistake_vault (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    university_code VARCHAR(20) NOT NULL,
    wrong_count INT NOT NULL DEFAULT 1,
    consecutive_correct INT NOT NULL DEFAULT 0,
    repetition_interval_days INT NOT NULL DEFAULT 1,   -- 1 day -> 3 days -> 7 days
    next_review_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '1 day'),
    is_mastered BOOLEAN NOT NULL DEFAULT FALSE,
    last_reviewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_mistake_vault_due ON mistake_vault(user_id, is_mastered, next_review_at);

-- ============================================================================
-- 5. RPC FUNCTIONS FOR FRONTEND CLIENT
-- ============================================================================

-- Compute or fetch student roadmap
CREATE OR REPLACE FUNCTION get_student_roadmap(p_user_id UUID, p_university_code VARCHAR)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_blueprint JSONB;
    v_sections JSONB;
    v_summit_score FLOAT := 0.0;
    v_milestones JSONB;
BEGIN
    IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Cannot access another learner roadmap';
    END IF;

    -- 1. Fetch university blueprint
    SELECT to_jsonb(b) INTO v_blueprint
    FROM university_blueprints b
    WHERE b.university_code = LOWER(p_university_code)
    LIMIT 1;

    IF v_blueprint IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'University blueprint not found');
    END IF;

    -- 2. Aggregate section progress
    SELECT jsonb_agg(
        jsonb_build_object(
            'id', s.value->>'id',
            'title', s.value->>'title',
            'marks', (s.value->>'marks')::int,
            'weight', (s.value->>'weight')::float,
            'color_hex', s.value->>'color_hex',
            'progress', COALESCE(p.mastery_percentage, 0.0)
        )
    ) INTO v_sections
    FROM jsonb_array_elements(v_blueprint->'sections') AS s
    LEFT JOIN student_section_progress p 
        ON p.user_id = p_user_id 
        AND p.university_code = LOWER(p_university_code) 
        AND p.section_id = s.value->>'id';

    -- 3. Calculate weighted summit readiness score
    SELECT COALESCE(SUM((s.value->>'weight')::float * COALESCE(p.mastery_percentage, 0.0)), 0.0)
    INTO v_summit_score
    FROM jsonb_array_elements(v_blueprint->'sections') AS s
    LEFT JOIN student_section_progress p 
        ON p.user_id = p_user_id 
        AND p.university_code = LOWER(p_university_code) 
        AND p.section_id = s.value->>'id';

    -- 4. Fetch milestone trail progress
    SELECT jsonb_agg(
        jsonb_build_object(
            'node_id', m.node_id,
            'status', m.status,
            'score', m.score_percentage
        )
    ) INTO v_milestones
    FROM student_milestone_progress m
    WHERE m.user_id = p_user_id AND m.university_code = LOWER(p_university_code);

    RETURN jsonb_build_object(
        'success', true,
        'university_code', p_university_code,
        'blueprint', v_blueprint,
        'summit_score', ROUND(v_summit_score::numeric, 1),
        'sections', COALESCE(v_sections, '[]'::jsonb),
        'milestones', COALESCE(v_milestones, '[]'::jsonb)
    );
END;
$$;
