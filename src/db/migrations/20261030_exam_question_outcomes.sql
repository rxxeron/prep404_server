-- Store authoritative per-question outcomes without retaining submitted answer
-- maps as the analytics source. Option labels can be shuffled per exam session.
CREATE TABLE IF NOT EXISTS public.exam_submission_answers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    submission_id UUID NOT NULL REFERENCES public.exam_submissions(id) ON DELETE CASCADE,
    question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
    subject_id UUID,
    topic_id UUID,
    selected_option TEXT,
    correct_option TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('correct', 'wrong', 'skipped')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (submission_id, question_id)
);
CREATE INDEX IF NOT EXISTS exam_submission_answers_topic_idx
    ON public.exam_submission_answers (topic_id, submission_id);
CREATE INDEX IF NOT EXISTS exam_submission_answers_subject_idx
    ON public.exam_submission_answers (subject_id, submission_id);
CREATE INDEX IF NOT EXISTS exam_submissions_nonpractice_submitted_at_idx
    ON public.exam_submissions (submitted_at DESC)
    WHERE is_practice = false;
ALTER TABLE public.exam_submission_answers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_submission_answers FROM anon, authenticated;
