-- Migration: Least-Privilege API Role and Direct Read Table RLS Audit
-- Fulfills D4 & D5 from Codebase Review

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'prep404_api_role') THEN
    CREATE ROLE prep404_api_role WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;

-- Grant schema usage
GRANT USAGE ON SCHEMA public TO prep404_api_role;

-- Grant explicit DML privileges on operational application tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prep404_api_role;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO prep404_api_role;

-- Ensure future tables inherit DML but NOT DDL/drop privileges
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prep404_api_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO prep404_api_role;

-- Revoke dangerous administrative capabilities from the operational role
REVOKE CREATE ON SCHEMA public FROM prep404_api_role;
