-- =========================================================================
-- Academic Batches & Boards Dynamic Configuration Schema
-- Allows administrators to dynamically add or toggle new admission batches
-- directly from the Supabase Table Editor without code deployments.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.academic_batches (
    id VARCHAR(64) PRIMARY KEY,
    curriculum_type VARCHAR(32) NOT NULL,            -- 'NCTB' or 'ENGLISH_MEDIUM'
    exam_level VARCHAR(32) NOT NULL,                 -- 'SSC', 'HSC', 'O_LEVEL', 'A_LEVEL'
    batch_name VARCHAR(64) NOT NULL,                -- e.g. "HSC '26 (Appearing)", "2024", "A-Level '25"
    passing_year INT NOT NULL,                      -- e.g. 2026, 2025, 2024
    linked_prerequisite_year INT,                   -- SSC year for HSC, O-Level year for A-Level
    is_active BOOLEAN DEFAULT TRUE,                 -- Toggle to show/hide in the app
    is_appearing BOOLEAN DEFAULT FALSE,
    is_second_timer BOOLEAN DEFAULT FALSE,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_academic_batches_lookup 
ON public.academic_batches (exam_level, is_active, linked_prerequisite_year);

CREATE TABLE IF NOT EXISTS public.academic_boards (
    id VARCHAR(64) PRIMARY KEY,
    board_name VARCHAR(128) NOT NULL,               -- e.g. 'Cambridge International', 'Pearson Edexcel'
    short_name VARCHAR(64),                         -- e.g. 'CAIE', 'Edexcel', 'IB'
    curriculum_type VARCHAR(32) DEFAULT 'ENGLISH_MEDIUM',
    is_active BOOLEAN DEFAULT TRUE,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Public Read Policies
ALTER TABLE public.academic_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.academic_boards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can view active academic_batches" ON public.academic_batches;
CREATE POLICY "Public can view active academic_batches" 
ON public.academic_batches FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public can view active academic_boards" ON public.academic_boards;
CREATE POLICY "Public can view active academic_boards" 
ON public.academic_boards FOR SELECT USING (true);

GRANT SELECT ON public.academic_batches TO anon, authenticated;
GRANT SELECT ON public.academic_boards TO anon, authenticated;
