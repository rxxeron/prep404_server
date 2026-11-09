-- The learner client writes onboarding fields only. XP, league, coins,
-- premium state, tokens, and account timestamps remain server controlled.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_authenticated_owner_access" ON public.users;
DROP POLICY IF EXISTS "users_authenticated_owner_scope" ON public.users;
DROP POLICY IF EXISTS "Users can insert/update" ON public.users;
DROP POLICY IF EXISTS "Users are viewable by everyone" ON public.users;

REVOKE ALL ON public.users FROM anon, authenticated;
GRANT SELECT ON public.users TO authenticated;
GRANT INSERT (
  id, phone, full_name, gender, division_id, division_name, district_id, district_name,
  medium, academic_batch, institution_name, ssc_group, ssc_year, ssc_gpa,
  ssc_institution, ssc_eiin, hsc_group, hsc_batch, hsc_gpa, hsc_institution,
  hsc_eiin, o_level_board, o_level_year, o_level_grades, o_level_school,
  a_level_board, a_level_batch, a_level_status, a_level_grades, a_level_college,
  target_universities, target_disciplines, updated_at
) ON public.users TO authenticated;
GRANT UPDATE (
  phone, full_name, gender, division_id, division_name, district_id, district_name,
  medium, academic_batch, institution_name, ssc_group, ssc_year, ssc_gpa,
  ssc_institution, ssc_eiin, hsc_group, hsc_batch, hsc_gpa, hsc_institution,
  hsc_eiin, o_level_board, o_level_year, o_level_grades, o_level_school,
  a_level_board, a_level_batch, a_level_status, a_level_grades, a_level_college,
  target_universities, target_disciplines, updated_at
) ON public.users TO authenticated;

CREATE POLICY "Learners can read their own profile"
  ON public.users FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "Learners can create their own profile"
  ON public.users FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "Learners can update their own profile"
  ON public.users FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
