-- Make the staff audit stream append-only through the normal database API.
CREATE OR REPLACE FUNCTION public.reject_staff_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'staff_audit_logs is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS staff_audit_logs_no_mutation ON public.staff_audit_logs;
CREATE TRIGGER staff_audit_logs_no_mutation
  BEFORE UPDATE OR DELETE ON public.staff_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.reject_staff_audit_mutation();

DROP TRIGGER IF EXISTS staff_audit_logs_no_truncate ON public.staff_audit_logs;
CREATE TRIGGER staff_audit_logs_no_truncate
  BEFORE TRUNCATE ON public.staff_audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_staff_audit_mutation();
