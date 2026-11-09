-- ============================================================================
-- Prep404 Target Private Universities & Admission Engine Schema
-- Pure UUID Primary & Foreign Key Relations (Supabase / PostgreSQL 15+)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Drop existing tables if recreating to transition to UUIDs
DROP TABLE IF EXISTS public.program_pattern_mappings CASCADE;
DROP TABLE IF EXISTS public.admission_cycles CASCADE;
DROP TABLE IF EXISTS public.admission_test_patterns CASCADE;
DROP TABLE IF EXISTS public.program_fee_structures CASCADE;
DROP TABLE IF EXISTS public.programs CASCADE;
DROP TABLE IF EXISTS public.academic_units CASCADE;
DROP TABLE IF EXISTS public.universities CASCADE;

-- ============================================================================
-- 1. UNIVERSITIES CATALOG
-- ============================================================================
CREATE TABLE public.universities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,                          -- 'nsu', 'brac', 'aust'
    code VARCHAR(20) UNIQUE NOT NULL,                  -- 'NSU', 'BRACU', 'AUST'
    full_name TEXT NOT NULL,
    short_name TEXT NOT NULL,
    academic_system TEXT NOT NULL CHECK (academic_system IN ('trimester', 'semester')),
    campus_location TEXT NOT NULL,
    website_url TEXT,
    admission_portal_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_universities_slug ON public.universities(slug);
CREATE INDEX idx_universities_code ON public.universities(code);

ALTER TABLE public.universities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Universities are viewable by everyone" 
    ON public.universities FOR SELECT USING (true);


-- ============================================================================
-- 2. ACADEMIC UNITS (Schools, Faculties, Departments)
-- ============================================================================
CREATE TABLE public.academic_units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    university_id UUID NOT NULL REFERENCES public.universities(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,                                 -- 'seps', 'sbe', 'bbs'
    unit_type TEXT NOT NULL CHECK (unit_type IN ('school', 'faculty', 'department', 'institute')),
    name TEXT NOT NULL,                                 -- 'School of Engineering and Physical Sciences'
    short_code VARCHAR(30),                             -- 'SEPS', 'SBE'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_academic_units_slug UNIQUE (university_id, slug)
);

CREATE INDEX idx_academic_units_uni ON public.academic_units(university_id);

ALTER TABLE public.academic_units ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Academic units are viewable by everyone" 
    ON public.academic_units FOR SELECT USING (true);


-- ============================================================================
-- 3. DEGREE PROGRAMS
-- ============================================================================
CREATE TABLE public.programs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    university_id UUID NOT NULL REFERENCES public.universities(id) ON DELETE CASCADE,
    academic_unit_id UUID NOT NULL REFERENCES public.academic_units(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,                                 -- 'cse', 'bba', 'eee'
    name TEXT NOT NULL,                                 -- 'B.Sc. in Computer Science & Engineering'
    degree_type TEXT NOT NULL DEFAULT 'bachelor' CHECK (degree_type IN ('bachelor', 'master', 'diploma')),
    track_category TEXT NOT NULL CHECK (track_category IN ('engineering', 'business', 'pharmacy', 'law', 'sciences', 'humanities', 'architecture')),
    total_credits NUMERIC(5, 1) NOT NULL CHECK (total_credits > 0),
    duration_years NUMERIC(3, 1) DEFAULT 4.0 CHECK (duration_years > 0),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_programs_slug UNIQUE (university_id, slug)
);

CREATE INDEX idx_programs_uni ON public.programs(university_id);
CREATE INDEX idx_programs_unit ON public.programs(academic_unit_id);
CREATE INDEX idx_programs_category ON public.programs(track_category);

ALTER TABLE public.programs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Programs are viewable by everyone" 
    ON public.programs FOR SELECT USING (true);


-- ============================================================================
-- 4. PROGRAM FINANCIAL STRUCTURES (Per-Credit vs Flat-Semester Model)
-- ============================================================================
CREATE TABLE public.program_fee_structures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id UUID UNIQUE NOT NULL REFERENCES public.programs(id) ON DELETE CASCADE,
    billing_model TEXT NOT NULL CHECK (billing_model IN ('per_credit', 'flat_semester')),
    admission_fee_onetime NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    caution_deposit_refundable NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    tuition_per_credit NUMERIC(12, 2),
    semester_fixed_tuition NUMERIC(12, 2),
    recurring_term_fees NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    mandatory_extra_fees JSONB DEFAULT '{}'::jsonb,
    estimated_total_cost NUMERIC(12, 2) NOT NULL CHECK (estimated_total_cost >= 0),
    effective_year INT NOT NULL DEFAULT 2026,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_fee_structures_program ON public.program_fee_structures(program_id);

ALTER TABLE public.program_fee_structures ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Fee structures are viewable by everyone" 
    ON public.program_fee_structures FOR SELECT USING (true);


-- ============================================================================
-- 5. ADMISSION TEST PATTERNS (Powers Prep404 Mock Exams)
-- ============================================================================
CREATE TABLE public.admission_test_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    university_id UUID NOT NULL REFERENCES public.universities(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,                                 -- 'eng-test', 'bba-test'
    pattern_name TEXT NOT NULL,
    test_archetype TEXT NOT NULL CHECK (test_archetype IN ('sat_aptitude', 'nctb_science', 'hybrid_viva')),
    total_marks INT NOT NULL CHECK (total_marks > 0),
    duration_minutes INT NOT NULL CHECK (duration_minutes > 0),
    has_negative_marking BOOLEAN DEFAULT FALSE,
    negative_marking_penalty NUMERIC(4, 2) DEFAULT 0.00,
    has_viva BOOLEAN DEFAULT FALSE,
    direct_admission_criteria JSONB DEFAULT '{}'::jsonb,
    sections JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_test_patterns_slug UNIQUE (university_id, slug)
);

CREATE INDEX idx_patterns_uni ON public.admission_test_patterns(university_id);
CREATE INDEX idx_patterns_sections_gin ON public.admission_test_patterns USING gin (sections jsonb_path_ops);

ALTER TABLE public.admission_test_patterns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Test patterns are viewable by everyone" 
    ON public.admission_test_patterns FOR SELECT USING (true);


-- ============================================================================
-- 6. PROGRAM TO PATTERN JUNCTION (UUID Relations)
-- ============================================================================
CREATE TABLE public.program_pattern_mappings (
    program_id UUID NOT NULL REFERENCES public.programs(id) ON DELETE CASCADE,
    pattern_id UUID NOT NULL REFERENCES public.admission_test_patterns(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (program_id, pattern_id)
);

CREATE INDEX idx_ppm_program_id ON public.program_pattern_mappings(program_id);
CREATE INDEX idx_ppm_pattern_id ON public.program_pattern_mappings(pattern_id);

ALTER TABLE public.program_pattern_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Program mappings are viewable by everyone" 
    ON public.program_pattern_mappings FOR SELECT USING (true);


-- ============================================================================
-- 7. ADMISSION CYCLES & EXAM DATES (Calendar with UUID Foreign Key)
-- ============================================================================
CREATE TABLE public.admission_cycles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    university_id UUID NOT NULL REFERENCES public.universities(id) ON DELETE CASCADE,
    season TEXT NOT NULL CHECK (season IN ('Spring', 'Summer', 'Fall', 'Autumn')),
    academic_year INT NOT NULL CHECK (academic_year >= 2024),
    slot_number INT NOT NULL DEFAULT 1 CHECK (slot_number >= 1),
    application_deadline TIMESTAMPTZ,
    exam_date DATE NOT NULL,
    exam_time TEXT,
    admit_card_available_date DATE,
    result_date DATE,
    status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'ongoing', 'completed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_cycle_slot UNIQUE (university_id, season, academic_year, slot_number)
);

CREATE INDEX idx_cycles_uni ON public.admission_cycles(university_id);
CREATE INDEX idx_cycles_calendar ON public.admission_cycles(status, exam_date);

ALTER TABLE public.admission_cycles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admission cycles are viewable by everyone" 
    ON public.admission_cycles FOR SELECT USING (true);
