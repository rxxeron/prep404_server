DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.exams'::regclass
      AND conname = 'exams_total_marks_bounds_check'
  ) THEN
    ALTER TABLE public.exams
      ADD CONSTRAINT exams_total_marks_bounds_check
      CHECK (total_marks > 0 AND total_marks <= 2000) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.exams'::regclass
      AND conname = 'exams_duration_seconds_bounds_check'
  ) THEN
    ALTER TABLE public.exams
      ADD CONSTRAINT exams_duration_seconds_bounds_check
      CHECK (duration_seconds BETWEEN 60 AND 36000) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.exams'::regclass
      AND conname = 'exams_negative_mark_bounds_check'
  ) THEN
    ALTER TABLE public.exams
      ADD CONSTRAINT exams_negative_mark_bounds_check
      CHECK (
        negative_mark_per_question IS NULL OR (
          negative_mark_per_question >= 0
          AND negative_mark_per_question <= 100
          AND negative_mark_per_question <= total_marks
        )
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.exams
  VALIDATE CONSTRAINT exams_total_marks_bounds_check;
ALTER TABLE public.exams
  VALIDATE CONSTRAINT exams_duration_seconds_bounds_check;
ALTER TABLE public.exams
  VALIDATE CONSTRAINT exams_negative_mark_bounds_check;
