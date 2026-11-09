-- Add unique usernames for managed staff sign-in.
ALTER TABLE public.staff_members
  ADD COLUMN IF NOT EXISTS username VARCHAR(32);

-- Deterministic backfill for any pre-existing staff rows.
UPDATE public.staff_members
SET username = 'staff_' || substr(replace(id::text, '-', ''), 1, 24)
WHERE username IS NULL OR username !~ '^[a-z0-9_]{3,32}$';

ALTER TABLE public.staff_members
  ALTER COLUMN username SET NOT NULL;

ALTER TABLE public.staff_members
  DROP CONSTRAINT IF EXISTS staff_members_username_format_check;
ALTER TABLE public.staff_members
  ADD CONSTRAINT staff_members_username_format_check
  CHECK (username ~ '^[a-z0-9_]{3,32}$');

CREATE UNIQUE INDEX IF NOT EXISTS staff_members_username_lower_uidx
  ON public.staff_members (lower(username));
