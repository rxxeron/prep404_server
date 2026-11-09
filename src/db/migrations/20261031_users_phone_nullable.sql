-- Email and Google sign-ins can finish onboarding without a phone number.
-- Keep uniqueness for phone numbers that learners choose to provide.
ALTER TABLE public.users ALTER COLUMN phone DROP NOT NULL;
