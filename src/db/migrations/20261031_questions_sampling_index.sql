-- Migration: Add performant sampling index for question bank and exam generation
-- Replaces slow O(N) ORDER BY random() full-table scans with O(log N) indexed keyset sampling.

CREATE INDEX IF NOT EXISTS idx_questions_active_sampling 
ON public.questions (review_status, id) 
WHERE (is_active = true);

CREATE INDEX IF NOT EXISTS idx_questions_subject_sampling 
ON public.questions (subject_id, id) 
WHERE (is_active = true AND review_status = 'approved');

CREATE INDEX IF NOT EXISTS idx_questions_topic_sampling 
ON public.questions (topic_id, id) 
WHERE (is_active = true AND review_status = 'approved');
