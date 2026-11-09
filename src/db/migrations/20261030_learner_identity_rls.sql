-- Restrict learner-owned rows to the authenticated owner even if older
-- permissive policies remain on a deployed database. The backend uses its
-- privileged database connection for verified writes and is unaffected.
DO $$
DECLARE
  item record;
  table_reg regclass;
  owner_column text;
  permissive_name text;
  restrictive_name text;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('users', 'id'),
      ('exam_submissions', 'user_id'),
      ('user_practice_progress', 'user_id'),
      ('student_section_progress', 'user_id'),
      ('student_milestone_progress', 'user_id'),
      ('mistake_vault', 'user_id'),
      ('question_reports', 'reporter_id')
    ) AS owned_tables(table_name, owner_column)
  LOOP
    table_reg := to_regclass(format('public.%I', item.table_name));
    IF table_reg IS NULL THEN
      CONTINUE;
    END IF;

    owner_column := item.owner_column;
    permissive_name := item.table_name || '_authenticated_owner_access';
    restrictive_name := item.table_name || '_authenticated_owner_scope';
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', table_reg);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename=item.table_name AND policyname=permissive_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %s AS PERMISSIVE FOR ALL TO authenticated USING ((SELECT auth.uid()) = %I) WITH CHECK ((SELECT auth.uid()) = %I)',
        permissive_name, table_reg, owner_column, owner_column
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename=item.table_name AND policyname=restrictive_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %s AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT auth.uid()) = %I) WITH CHECK ((SELECT auth.uid()) = %I)',
        restrictive_name, table_reg, owner_column, owner_column
      );
    END IF;
  END LOOP;
END $$;
