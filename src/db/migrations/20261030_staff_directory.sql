-- Staff accounts are managed only through the authenticated backend.
CREATE TABLE IF NOT EXISTS public.staff_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  role VARCHAR(30) NOT NULL DEFAULT 'setter' CHECK (role IN ('super_admin', 'setter', 'moderator', 'scheduler', 'support')),
  assigned_subjects TEXT[] DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.staff_members
  ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.staff_members
  DROP CONSTRAINT IF EXISTS staff_members_role_check;
ALTER TABLE public.staff_members
  ADD CONSTRAINT staff_members_role_check
  CHECK (role IN ('super_admin', 'setter', 'moderator', 'scheduler', 'support'));

CREATE UNIQUE INDEX IF NOT EXISTS staff_members_email_lower_uidx
  ON public.staff_members (lower(email));

ALTER TABLE public.staff_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_members FROM anon, authenticated;
