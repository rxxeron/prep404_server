-- ============================================================================
-- Prep404 Enterprise English Medium Institutions & Colleges Schema
-- Targeted for PostgreSQL 15+ / Supabase (UUID Primary Keys Architecture)
-- Strictly separated from Bangla Medium / NCTB 'institutions' table
-- Covers: Cambridge International (CAIE), Pearson Edexcel, International Baccalaureate (IB)
-- ============================================================================

-- Ensure required PostgreSQL extensions are active
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- Trigram indexing for fuzzy search autocomplete

-- Drop views and table if rebuilding
DROP VIEW IF EXISTS view_english_medium_institutions CASCADE;
DROP VIEW IF EXISTS english_medium_colleges CASCADE;
DROP TABLE IF EXISTS english_medium_institutions CASCADE;

-- ============================================================================
-- 1. MAIN ENGLISH MEDIUM INSTITUTIONS TABLE (Independent Table)
-- ============================================================================
CREATE TABLE english_medium_institutions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,                          -- Official Institution Name
    district VARCHAR(100) NOT NULL,                      -- District Name (e.g. 'Dhaka', 'Chattogram')
    district_id UUID REFERENCES districts(id) ON DELETE SET NULL,
    division_id UUID REFERENCES divisions(id) ON DELETE SET NULL,
    area VARCHAR(150) NOT NULL,                          -- Neighborhood / Area (e.g. 'Banani', 'Gulshan', 'Uttara')
    thana_id UUID REFERENCES thanas(id) ON DELETE SET NULL,
    
    -- Institution Type & Offerings
    institution_type VARCHAR(50) NOT NULL,               -- 'College', 'School & College', 'School', 'Grammar School', 'Academy', 'Tutorial'
    is_college BOOLEAN NOT NULL DEFAULT FALSE,           -- Offers College / Higher Secondary / A-Level
    is_school BOOLEAN NOT NULL DEFAULT FALSE,            -- Offers School / Secondary / O-Level
    
    -- Curriculum Examination Board(s)
    board_type VARCHAR(100) NOT NULL,                    -- 'Cambridge International', 'Pearson Edexcel', 'Dual (Cambridge & Edexcel)', 'International Baccalaureate (IB)'
    is_cambridge BOOLEAN NOT NULL DEFAULT FALSE,         -- Cambridge Assessment International Education (CAIE)
    is_edexcel BOOLEAN NOT NULL DEFAULT FALSE,           -- Pearson Edexcel
    is_ib BOOLEAN NOT NULL DEFAULT FALSE,                -- International Baccalaureate (IB)
    
    -- Web & Contact Information
    website TEXT,                                        -- Official Website / Portal / Social Page
    email VARCHAR(255),                                  -- Official Admissions / Admin Email
    
    source VARCHAR(150) DEFAULT 'British Council & International Accreditation Directories',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- 2. ULTRA-OPTIMIZED INDEXES FOR HIGH-CONCURRENCY APP PERFORMANCE
-- ============================================================================
CREATE INDEX idx_emi_district_id ON english_medium_institutions(district_id);
CREATE INDEX idx_emi_division_id ON english_medium_institutions(division_id);
CREATE INDEX idx_emi_thana_id ON english_medium_institutions(thana_id);
CREATE INDEX idx_emi_board_type ON english_medium_institutions(board_type);
CREATE INDEX idx_emi_institution_type ON english_medium_institutions(institution_type);
CREATE INDEX idx_emi_is_college ON english_medium_institutions(is_college) WHERE is_college = TRUE;
CREATE INDEX idx_emi_is_school ON english_medium_institutions(is_school) WHERE is_school = TRUE;

-- Trigram GIN Fuzzy Autocomplete Index for English Medium instant search
CREATE INDEX idx_emi_name_trgm ON english_medium_institutions USING gin (name gin_trgm_ops);

-- ============================================================================
-- 3. ROW LEVEL SECURITY (RLS) - PUBLIC READ ACCESS
-- ============================================================================
ALTER TABLE english_medium_institutions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "English medium institutions are viewable by everyone" ON english_medium_institutions;
CREATE POLICY "English medium institutions are viewable by everyone" 
    ON english_medium_institutions FOR SELECT USING (true);

-- ============================================================================
-- 4. CONVENIENCE VIEWS FOR APPLICATION CONSUMPTION
-- ============================================================================

-- View filtered specifically for English Medium Colleges / Higher Secondary wings
CREATE OR REPLACE VIEW english_medium_colleges AS
SELECT * 
FROM english_medium_institutions 
WHERE is_college = TRUE;

-- Fully denormalized view with joined administrative boundaries
CREATE OR REPLACE VIEW view_english_medium_institutions AS
SELECT 
    emi.id,
    emi.name,
    emi.institution_type,
    emi.is_college,
    emi.is_school,
    emi.board_type,
    emi.is_cambridge,
    emi.is_edexcel,
    emi.is_ib,
    emi.area,
    emi.district,
    d.name_en AS district_name_en,
    d.name_bn AS district_name_bn,
    div.name_en AS division_name_en,
    div.name_bn AS division_name_bn,
    t.name_en AS thana_name_en,
    t.name_bn AS thana_name_bn,
    emi.website,
    emi.email,
    emi.source,
    emi.is_active,
    emi.created_at
FROM english_medium_institutions emi
LEFT JOIN districts d ON emi.district_id = d.id
LEFT JOIN divisions div ON emi.division_id = div.id
LEFT JOIN thanas t ON emi.thana_id = t.id;
