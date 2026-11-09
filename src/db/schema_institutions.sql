-- ============================================================================
-- Prep404 Enterprise Educational Institutions Hierarchy & Search Schema
-- Targeted for PostgreSQL 15+ / Supabase (UUID Primary Keys Architecture)
-- Covers: Divisions -> Districts -> Thanas -> Institutions
-- Zero "NONE" / "কোনোটিই নয়" - Full English & Bangla Names
-- ============================================================================

-- Ensure required PostgreSQL extensions are active
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- Trigram indexing for fuzzy search autocomplete

-- Drop old serial-id tables if they were created earlier to rebuild with clean UUIDs
DROP VIEW IF EXISTS view_institutions_expanded CASCADE;
DROP TABLE IF EXISTS institutions CASCADE;
DROP TABLE IF EXISTS thanas CASCADE;
DROP TABLE IF EXISTS districts CASCADE;
DROP TABLE IF EXISTS divisions CASCADE;

-- ============================================================================
-- 1. ADMINISTRATIVE HIERARCHY (UUID Keys with English & Bangla)
-- ============================================================================

-- 1.1 Divisions (8 Administrative Divisions of Bangladesh)
CREATE TABLE divisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name_en VARCHAR(50) NOT NULL,
    name_bn VARCHAR(100) NOT NULL UNIQUE,
    code VARCHAR(10),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 1.2 Districts (64 Districts of Bangladesh)
CREATE TABLE districts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    division_id UUID NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
    name_en VARCHAR(50) NOT NULL,
    name_bn VARCHAR(100) NOT NULL,
    code VARCHAR(10),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_district_division_bn UNIQUE (division_id, name_bn)
);

CREATE INDEX idx_districts_division_id ON districts(division_id);

-- 1.3 Thanas / Upazilas (Clean Upazilas of Bangladesh)
CREATE TABLE thanas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    district_id UUID NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
    name_en VARCHAR(100) NOT NULL,
    name_bn VARCHAR(100) NOT NULL,
    code VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_thana_district_bn UNIQUE (district_id, name_bn)
);

CREATE INDEX idx_thanas_district_id ON thanas(district_id);

-- ============================================================================
-- 2. INSTITUTIONS (Official Live BANBEIS Educational Institutions)
-- ============================================================================

CREATE TABLE institutions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    eiin VARCHAR(10) UNIQUE NOT NULL,                    -- 6-digit BANBEIS EIIN (e.g. '107975')
    name_en VARCHAR(255) NOT NULL,                       -- English Name (e.g. 'DHAKA CITY COLLEGE')
    name_bn VARCHAR(255),                                -- Bangla Name (e.g. 'ঢাকা সিটি কলেজ')
    thana_id UUID NOT NULL REFERENCES thanas(id) ON DELETE RESTRICT,
    
    -- Category Boolean Flags ("Ticked" Indicators)
    is_school BOOLEAN NOT NULL DEFAULT FALSE,            -- Secondary / High School
    is_college BOOLEAN NOT NULL DEFAULT FALSE,           -- Intermediate / Degree / Honors College
    is_madrasa BOOLEAN NOT NULL DEFAULT FALSE,           -- Madrasha (Dakhil / Alim / Fazil / Kamil)
    is_technical BOOLEAN NOT NULL DEFAULT FALSE,         -- Polytechnic / Vocational / Technical
    
    mobile_masked VARCHAR(25),                           -- Masked telephone
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- 3. RELATIONAL LINK TO EXISTING USERS TABLE
-- ============================================================================

DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'users' AND column_name = 'institution_id'
    ) THEN
        ALTER TABLE users ADD COLUMN institution_id UUID REFERENCES institutions(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'users' AND column_name = 'institution_eiin'
    ) THEN
        ALTER TABLE users ADD COLUMN institution_eiin VARCHAR(10) REFERENCES institutions(eiin) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_institution_id ON users(institution_id);
CREATE INDEX IF NOT EXISTS idx_users_institution_eiin ON users(institution_eiin);

-- ============================================================================
-- 4. ULTRA-OPTIMIZED INDEXES FOR HIGH-CONCURRENCY APP PERFORMANCE
-- ============================================================================

-- 4.1 Foreign Key Lookups
CREATE INDEX idx_institutions_thana ON institutions(thana_id);
CREATE INDEX idx_institutions_eiin ON institutions(eiin);

-- 4.2 Partial Indexes for Instant "Ticked" Category Views (< 0.1ms query time)
CREATE INDEX idx_inst_school_and_college 
    ON institutions (thana_id, name_en) 
    WHERE is_school = TRUE AND is_college = TRUE;

CREATE INDEX idx_inst_school_only 
    ON institutions (thana_id, name_en) 
    WHERE is_school = TRUE AND is_college = FALSE;

CREATE INDEX idx_inst_college_only 
    ON institutions (thana_id, name_en) 
    WHERE is_college = TRUE AND is_school = FALSE;

CREATE INDEX idx_inst_madrasa 
    ON institutions (thana_id, name_en) 
    WHERE is_madrasa = TRUE;

CREATE INDEX idx_inst_technical 
    ON institutions (thana_id, name_en) 
    WHERE is_technical = TRUE;

-- 4.3 Trigram GIN Fuzzy Autocomplete Indexes (English & Bangla search bars)
CREATE INDEX idx_institutions_name_en_trgm 
    ON institutions USING gin (name_en gin_trgm_ops);

CREATE INDEX idx_institutions_name_bn_trgm 
    ON institutions USING gin (name_bn gin_trgm_ops);

-- ============================================================================
-- 5. DENORMALIZED READY-TO-CONSUME APPLICATION VIEW
-- ============================================================================

CREATE OR REPLACE VIEW view_institutions_expanded AS
SELECT 
    i.id AS institution_id,
    i.eiin,
    i.name_en,
    i.name_bn,
    i.is_school,
    i.is_college,
    i.is_madrasa,
    i.is_technical,
    CASE 
        WHEN i.is_school = TRUE AND i.is_college = TRUE THEN 'School & College'
        WHEN i.is_college = TRUE THEN 'College'
        WHEN i.is_school = TRUE THEN 'School'
        WHEN i.is_madrasa = TRUE THEN 'Madrasah'
        WHEN i.is_technical = TRUE THEN 'Technical Institute'
        ELSE 'Other'
    END AS display_category,
    t.id AS thana_id,
    t.name_en AS thana_name_en,
    t.name_bn AS thana_name_bn,
    t.code AS thana_code,
    d.id AS district_id,
    d.name_en AS district_name_en,
    d.name_bn AS district_name_bn,
    d.code AS district_code,
    div.id AS division_id,
    div.name_en AS division_name_en,
    div.name_bn AS division_name_bn,
    div.code AS division_code,
    i.mobile_masked,
    i.is_active
FROM institutions i
JOIN thanas t ON i.thana_id = t.id
JOIN districts d ON t.district_id = d.id
JOIN divisions div ON d.division_id = div.id;
