-- Makes learner support POST retries safe after slow or interrupted responses.
-- Existing support requests keep a NULL key and remain unchanged.
ALTER TABLE public.learner_support_requests
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS learner_support_request_idempotency_uidx
  ON public.learner_support_requests (requester_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The table is backend-only already; keep the new column inaccessible through
-- Supabase's client roles along with the rest of the support table.
REVOKE ALL ON public.learner_support_requests FROM anon, authenticated;
