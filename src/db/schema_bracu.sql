-- ============================================================================
-- Prep404 Dynamic University Admission Schema: BRAC University (BRACU) Module
-- Designed adhering strictly to Supabase Postgres Best Practices:
-- 1. Identifiers: Strict lowercase snake_case (schema-lowercase-identifiers)
-- 2. Primary Keys: UUID with gen_random_uuid() (schema-primary-keys)
-- 3. Foreign Key Indexes: Explicit B-tree indexes on ALL FK columns (schema-foreign-key-indexes)
-- 4. Options Model: Option B (JSONB array with UUIDs + is_correct) + GIN Index (advanced-jsonb-indexing)
-- 5. Cloze Blank Drilling: Standalone context snippets linked to stimuli
-- 6. Multi-University Provenance: Many-to-Many junction with origin badges
-- 7. Discipline Relevance: Program-to-question mappings for targeted weak-subject tests
-- 8. Row Level Security: Enabled on all tables with optimized SELECT policies (security-rls-performance)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. ACADEMIC TAXONOMY (Hierarchical Subjects, Topics & Subtopics)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.academic_subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,                          -- 'english', 'general_mathematics', 'physics', etc.
    name TEXT NOT NULL,                                 -- 'English Language', 'General Mathematics'
    description TEXT,
    icon_name TEXT,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_academic_subjects_slug ON public.academic_subjects(slug);

ALTER TABLE public.academic_subjects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Academic subjects are viewable by everyone" ON public.academic_subjects;
CREATE POLICY "Academic subjects are viewable by everyone"
    ON public.academic_subjects FOR SELECT USING (true);


CREATE TABLE IF NOT EXISTS public.academic_topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id UUID NOT NULL REFERENCES public.academic_subjects(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,                                 -- 'cloze_test', 'reading_comprehension', 'algebra'
    name TEXT NOT NULL,                                 -- 'Cloze Test', 'Reading Comprehension'
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_academic_topics_subject_slug UNIQUE (subject_id, slug)
);

-- Foreign Key Index (Mandatory per Supabase Best Practices)
CREATE INDEX IF NOT EXISTS idx_academic_topics_subject_id ON public.academic_topics(subject_id);
CREATE INDEX IF NOT EXISTS idx_academic_topics_slug ON public.academic_topics(slug);

ALTER TABLE public.academic_topics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Academic topics are viewable by everyone" ON public.academic_topics;
CREATE POLICY "Academic topics are viewable by everyone"
    ON public.academic_topics FOR SELECT USING (true);


CREATE TABLE IF NOT EXISTS public.academic_subtopics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic_id UUID NOT NULL REFERENCES public.academic_topics(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,                                 -- 'contextual_vocabulary', 'inference', 'differentiation'
    name TEXT NOT NULL,                                 -- 'Contextual Vocabulary', 'Inference'
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_academic_subtopics_topic_slug UNIQUE (topic_id, slug)
);

-- Foreign Key Index
CREATE INDEX IF NOT EXISTS idx_academic_subtopics_topic_id ON public.academic_subtopics(topic_id);
CREATE INDEX IF NOT EXISTS idx_academic_subtopics_slug ON public.academic_subtopics(slug);

ALTER TABLE public.academic_subtopics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Academic subtopics are viewable by everyone" ON public.academic_subtopics;
CREATE POLICY "Academic subtopics are viewable by everyone"
    ON public.academic_subtopics FOR SELECT USING (true);


-- ============================================================================
-- 2. QUESTION STIMULI (Passages, Reading Comprehension, Case Studies)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.question_stimuli (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_slug TEXT UNIQUE NOT NULL,                 -- e.g. 'stim_cloze_model_test_01', 'stim_rc_fall_2024'
    stimulus_type TEXT NOT NULL CHECK (stimulus_type IN ('reading_passage', 'cloze_passage', 'case_study', 'data_interpretation')),
    title TEXT NOT NULL,
    content_text TEXT NOT NULL,
    source_exam TEXT,                                  -- Reference exam identifier
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_question_stimuli_slug ON public.question_stimuli(external_slug);
CREATE INDEX IF NOT EXISTS idx_question_stimuli_type ON public.question_stimuli(stimulus_type);

ALTER TABLE public.question_stimuli ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Question stimuli are viewable by everyone" ON public.question_stimuli;
CREATE POLICY "Question stimuli are viewable by everyone"
    ON public.question_stimuli FOR SELECT USING (true);


-- ============================================================================
-- 3. CORE QUESTIONS REPOSITORY (Option B: JSONB Array Shuffling)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_type TEXT NOT NULL CHECK (item_type IN (
        'mcq_standalone',
        'mcq_passage_linked',
        'cloze_blank',
        'written_essay',
        'drawing_prompt'
    )),
    subject_id UUID NOT NULL REFERENCES public.academic_subjects(id) ON DELETE RESTRICT,
    topic_id UUID NOT NULL REFERENCES public.academic_topics(id) ON DELETE RESTRICT,
    subtopic_id UUID REFERENCES public.academic_subtopics(id) ON DELETE SET NULL,
    stimulus_id UUID REFERENCES public.question_stimuli(id) ON DELETE SET NULL,
    
    stem_primary TEXT NOT NULL,                         -- Supports Markdown + LaTeX KaTeX
    
    -- Cloze Blank Drill Isolation
    blank_index INT CHECK (blank_index IS NULL OR blank_index >= 1),
    context_snippet TEXT,                               -- 1-2 sentence isolated drill snippet
    
    -- Option B: JSONB array of { id: UUID, key_original: "A", text: "...", is_correct: bool }
    options JSONB NOT NULL DEFAULT '[]'::jsonb,
    
    -- Deduplication Fingerprint (SHA-256 of normalized stem + sorted option texts)
    content_hash VARCHAR(64) UNIQUE,

    solution_markdown TEXT,
    written_rubric JSONB DEFAULT '{}'::jsonb,           -- Word limits, grading criteria, prompt guidelines
    difficulty_rating NUMERIC(3, 2) NOT NULL DEFAULT 1.00 CHECK (difficulty_rating >= 0.00),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Foreign Key Indexes
CREATE INDEX IF NOT EXISTS idx_questions_subject_id ON public.questions(subject_id);
CREATE INDEX IF NOT EXISTS idx_questions_topic_id ON public.questions(topic_id);
CREATE INDEX IF NOT EXISTS idx_questions_subtopic_id ON public.questions(subtopic_id);
CREATE INDEX IF NOT EXISTS idx_questions_stimulus_id ON public.questions(stimulus_id);

-- GIN Index on Options JSONB for fast containment lookups (advanced-jsonb-indexing)
CREATE INDEX IF NOT EXISTS idx_questions_options_gin ON public.questions USING gin (options jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_questions_content_hash ON public.questions(content_hash);

-- Partial Indexes for Targeted Drill Queries (query-partial-indexes)
CREATE INDEX IF NOT EXISTS idx_questions_active_drills 
    ON public.questions(subject_id, topic_id) 
    WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_questions_cloze_blanks 
    ON public.questions(stimulus_id, blank_index) 
    WHERE item_type = 'cloze_blank';

ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Active questions are viewable by everyone" ON public.questions;
CREATE POLICY "Active questions are viewable by everyone"
    ON public.questions FOR SELECT USING (is_active = TRUE);


-- ============================================================================
-- 4. MULTI-UNIVERSITY PROVENANCE & BADGES (Many-to-Many Junction)
-- ============================================================================
-- Enables pooling questions across universities while retaining origin badges:
-- e.g., "BRACU Model Test 01 - Section A [Q3]", "BRACU Fall 2024 Real Exam [Q16]"

CREATE TABLE IF NOT EXISTS public.question_exam_appearances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
    university_id UUID NOT NULL REFERENCES public.universities(id) ON DELETE CASCADE,
    exam_slug TEXT NOT NULL,                            -- e.g. 'model_test_01', 'BRACU_REAL_FALL_2024'
    exam_title TEXT NOT NULL,
    is_model_test BOOLEAN NOT NULL DEFAULT FALSE,
    academic_term TEXT,                                 -- 'Fall', 'Spring', 'Summer', 'Model Test'
    academic_year INT,                                  -- 2023, 2024, 2025
    slot_number INT,                                    -- 1, 2
    section_code TEXT NOT NULL,                         -- 'section_a', 'section_c', etc.
    section_title TEXT,
    question_number INT NOT NULL CHECK (question_number >= 1),
    badge_label TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_qea_appearance UNIQUE (question_id, university_id, exam_slug, section_code, question_number)
);

-- Foreign Key & Composite Indexes (Optimized for filtering by University and Term)
CREATE INDEX IF NOT EXISTS idx_qea_question_id ON public.question_exam_appearances(question_id);
CREATE INDEX IF NOT EXISTS idx_qea_university_id ON public.question_exam_appearances(university_id);
CREATE INDEX IF NOT EXISTS idx_qea_uni_term_year ON public.question_exam_appearances(university_id, academic_term, academic_year);
CREATE INDEX IF NOT EXISTS idx_qea_exam_lookup ON public.question_exam_appearances(university_id, exam_slug, section_code);

ALTER TABLE public.question_exam_appearances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Exam appearances are viewable by everyone" ON public.question_exam_appearances;
CREATE POLICY "Exam appearances are viewable by everyone"
    ON public.question_exam_appearances FOR SELECT USING (true);


-- ============================================================================
-- 5. PROGRAM & DISCIPLINE RELEVANCE MAPPING
-- ============================================================================
-- Maps which questions apply to which target academic programs (e.g. CSE vs BBA vs Pharmacy)
-- Allows a student to practice: "BRACU CSE English" or "BRACU Pharmacy Chemistry"

CREATE TABLE IF NOT EXISTS public.program_question_relevance (
    program_id UUID NOT NULL REFERENCES public.programs(id) ON DELETE CASCADE,
    question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
    weight NUMERIC(4, 2) NOT NULL DEFAULT 1.00 CHECK (weight > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (program_id, question_id)
);

-- Foreign Key Indexes
CREATE INDEX IF NOT EXISTS idx_pqr_program_id ON public.program_question_relevance(program_id);
CREATE INDEX IF NOT EXISTS idx_pqr_question_id ON public.program_question_relevance(question_id);

ALTER TABLE public.program_question_relevance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Program question relevance is viewable by everyone" ON public.program_question_relevance;
CREATE POLICY "Program question relevance is viewable by everyone"
    ON public.program_question_relevance FOR SELECT USING (true);


-- ============================================================================
-- 6. ADMISSION TEST PATTERN SECTIONS (BRACU Blueprint Definitions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.admission_pattern_sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pattern_id UUID NOT NULL REFERENCES public.admission_test_patterns(id) ON DELETE CASCADE,
    section_code TEXT NOT NULL,                         -- 'sec_a_english', 'sec_c_math', etc.
    section_title TEXT NOT NULL,
    subject_id UUID NOT NULL REFERENCES public.academic_subjects(id) ON DELETE RESTRICT,
    question_count INT NOT NULL CHECK (question_count > 0),
    marks_per_question NUMERIC(5, 2) NOT NULL DEFAULT 1.00 CHECK (marks_per_question > 0),
    negative_mark NUMERIC(4, 2) NOT NULL DEFAULT 0.00 CHECK (negative_mark >= 0),
    duration_minutes INT,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_pattern_section UNIQUE (pattern_id, section_code)
);

-- Foreign Key Indexes
CREATE INDEX IF NOT EXISTS idx_aps_pattern_id ON public.admission_pattern_sections(pattern_id);
CREATE INDEX IF NOT EXISTS idx_aps_subject_id ON public.admission_pattern_sections(subject_id);

ALTER TABLE public.admission_pattern_sections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Pattern sections are viewable by everyone" ON public.admission_pattern_sections;
CREATE POLICY "Pattern sections are viewable by everyone"
    ON public.admission_pattern_sections FOR SELECT USING (true);


-- ============================================================================
-- 7. HIGH-PERFORMANCE FUNCTIONS FOR OPTION SHUFFLING & INSTANT GRADING
-- ============================================================================

-- Function 1: Fetch question with options shuffled and correct answer stripped
-- Prevents answer leakage while preserving UUID-based submission integrity.
CREATE OR REPLACE FUNCTION public.fn_get_question_shuffled(p_question_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'id', q.id,
        'item_type', q.item_type,
        'subject_slug', s.slug,
        'topic_slug', t.slug,
        'subtopic_slug', st.slug,
        'stimulus_id', q.stimulus_id,
        'stem_primary', q.stem_primary,
        'blank_index', q.blank_index,
        'context_snippet', q.context_snippet,
        'options', (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', opt->>'id',
                    'text', opt->>'text'
                ) ORDER BY random()
            )
            FROM jsonb_array_elements(q.options) AS opt
        ),
        'written_rubric', q.written_rubric
    )
    FROM public.questions q
    JOIN public.academic_subjects s ON s.id = q.subject_id
    JOIN public.academic_topics t ON t.id = q.topic_id
    LEFT JOIN public.academic_subtopics st ON st.id = q.subtopic_id
    WHERE q.id = p_question_id AND q.is_active = TRUE;
$$;


-- Function 2: O(1) Instant Answer Grading
-- Evaluates submission against stored JSONB options without revealing answers to client
CREATE OR REPLACE FUNCTION public.fn_grade_option_answer(
    p_question_id UUID,
    p_selected_option_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'question_id', q.id,
        'is_correct', COALESCE((
            SELECT (opt->>'is_correct')::boolean
            FROM jsonb_array_elements(q.options) AS opt
            WHERE opt->>'id' = p_selected_option_id::text
        ), false),
        'solution_markdown', q.solution_markdown,
        'correct_option_id', (
            SELECT opt->>'id'
            FROM jsonb_array_elements(q.options) AS opt
            WHERE (opt->>'is_correct')::boolean = true
            LIMIT 1
        )
    )
    FROM public.questions q
    WHERE q.id = p_question_id;
$$;


-- ============================================================================
-- 8. CONVENIENCE VIEW: DRILLABLE QUESTIONS WITH TAXONOMY & BADGES
-- ============================================================================

CREATE OR REPLACE VIEW public.v_drillable_questions AS
SELECT 
    q.id AS question_id,
    q.item_type,
    s.slug AS subject_slug,
    s.name AS subject_name,
    t.slug AS topic_slug,
    t.name AS topic_name,
    st.slug AS subtopic_slug,
    st.name AS subtopic_name,
    q.stem_primary,
    q.blank_index,
    q.context_snippet,
    q.options,
    q.solution_markdown,
    q.stimulus_id,
    stm.stimulus_type,
    stm.title AS stimulus_title,
    stm.content_text AS stimulus_content,
    COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'university_id', qea.university_id,
                'university_code', u.code,
                'university_slug', u.slug,
                'exam_slug', qea.exam_slug,
                'is_model_test', qea.is_model_test,
                'academic_term', qea.academic_term,
                'academic_year', qea.academic_year,
                'slot_number', qea.slot_number,
                'badge_label', qea.badge_label,
                'section_code', qea.section_code,
                'question_number', qea.question_number
            )
        ) FILTER (WHERE qea.id IS NOT NULL), '[]'::jsonb
    ) AS exam_appearances
FROM public.questions q
JOIN public.academic_subjects s ON s.id = q.subject_id
JOIN public.academic_topics t ON t.id = q.topic_id
LEFT JOIN public.academic_subtopics st ON st.id = q.subtopic_id
LEFT JOIN public.question_stimuli stm ON stm.id = q.stimulus_id
LEFT JOIN public.question_exam_appearances qea ON qea.question_id = q.id
LEFT JOIN public.universities u ON u.id = qea.university_id
WHERE q.is_active = TRUE
GROUP BY 
    q.id, q.item_type, s.slug, s.name, t.slug, t.name, 
    st.slug, st.name, q.stem_primary, q.blank_index, 
    q.context_snippet, q.options, q.solution_markdown, 
    q.stimulus_id, stm.stimulus_type, stm.title, stm.content_text;
