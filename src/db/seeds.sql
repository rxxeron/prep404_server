-- ============================================================================
-- Prep404 Seed Data: Private University Admission (November Target)
-- ============================================================================

-- 1. Insert Universities
INSERT INTO private_universities (id, code, full_name, location, exam_date) VALUES
('nsu', 'NSU', 'North South University', 'Bashundhara R/A, Dhaka', '2026-11-28'),
('brac', 'BRACU', 'BRAC University', 'Merul Badda, Dhaka', '2026-11-29'),
('iub', 'IUB', 'Independent University, Bangladesh', 'Bashundhara R/A, Dhaka', '2026-11-26'),
('aust', 'AUST', 'Ahsanullah University of Science & Technology', 'Tejgaon, Dhaka', '2026-11-27'),
('uiu', 'UIU', 'United International University', 'Madani Avenue, Dhaka', '2026-11-25')
ON CONFLICT (id) DO NOTHING;

-- 2. Insert Disciplines
INSERT INTO university_disciplines (id, university_id, name, category, exam_sections) VALUES
('nsu_cse', 'nsu', 'Computer Science & Engineering (CSE)', 'engineering', '["General English", "Quantitative Math", "Higher Math", "Essay"]'),
('nsu_bba', 'nsu', 'Bachelor of Business Administration (BBA)', 'business', '["General English", "General Math", "Reading Comprehension", "Essay"]'),
('nsu_pharm', 'nsu', 'Bachelor of Pharmacy (B.Pharm)', 'pharmacy', '["General English", "Chemistry", "Biology", "General Math"]'),
('brac_cse', 'brac', 'Computer Science & Engineering (CSE)', 'engineering', '["English", "Higher Math", "Physics"]'),
('brac_bba', 'brac', 'BBA (BRAC Business School)', 'business', '["English", "Basic Math", "Aptitude"]'),
('iub_cse', 'iub', 'Computer Science (SEPS)', 'engineering', '["English Proficiency", "Quantitative Math"]'),
('aust_eng', 'aust', 'Engineering Units (CSE/EEE/CE)', 'engineering', '["Mathematics", "Physics", "Chemistry", "English"]')
ON CONFLICT (id) DO NOTHING;

-- 3. Insert Subjects & Topics
INSERT INTO subjects (id, track, title, display_order) VALUES
('sub_quant_math', 'private_uni', 'Quantitative Mathematics', 1),
('sub_higher_math', 'private_uni', 'Higher Math (Engineering Focus)', 2),
('sub_english_priv', 'private_uni', 'English Grammar & Vocabulary', 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO topics (id, subject_id, title, total_questions) VALUES
('top_algebra', 'sub_quant_math', 'Algebraic Equations & Fractions', 120),
('top_trig_calc', 'sub_higher_math', 'Calculus & Integration', 95),
('top_sentence_corr', 'sub_english_priv', 'Sentence Correction & Grammar', 150)
ON CONFLICT (id) DO NOTHING;

-- 4. Insert Sample Questions with KaTeX & Socratic Hints
INSERT INTO questions (
    id, subject_id, topic_id, question_text, has_math, options, correct_option, explanation, hints, difficulty_rating, target_universities, target_categories
) VALUES
(
    '00000000-0000-0000-0000-000000000001',
    'sub_quant_math',
    'top_algebra',
    'If $2^{x+3} = 32$, what is the value of $(x+1)^2$?',
    TRUE,
    '[{"id": "A", "text": "4"}, {"id": "B", "text": "9"}, {"id": "C", "text": "16"}, {"id": "D", "text": "25"}]'::jsonb,
    'B',
    'We rewrite 32 as power of 2: $32 = 2^5$. Therefore, $x+3 = 5 \implies x = 2$. Now evaluate $(x+1)^2 = (2+1)^2 = 3^2 = 9$.',
    '["Express the right-hand side 32 in base 2.", "Set exponents equal: x + 3 = 5 to isolate x.", "Plug x = 2 into (x+1)^2."]'::jsonb,
    1.2,
    ARRAY['NSU', 'BRACU', 'IUB'],
    ARRAY['engineering', 'business']
),
(
    '00000000-0000-0000-0000-000000000002',
    'sub_higher_math',
    'top_trig_calc',
    'What is the value of the definite integral $\int_0^{\pi/2} \cos(x) \, dx$?',
    TRUE,
    '[{"id": "A", "text": "0"}, {"id": "B", "text": "1"}, {"id": "C", "text": "-1"}, {"id": "D", "text": "1/2"}]'::jsonb,
    'B',
    'The antiderivative of $\cos(x)$ is $\sin(x)$. Evaluating from $0$ to $\pi/2$: $[\sin(\pi/2)] - [\sin(0)] = 1 - 0 = 1$.',
    '["Recall that the derivative of sin(x) is cos(x).", "Apply the Fundamental Theorem of Calculus: F(b) - F(a).", "sin(pi/2) = 1 and sin(0) = 0."]'::jsonb,
    1.5,
    ARRAY['NSU', 'BRACU', 'AUST'],
    ARRAY['engineering']
),
(
    '00000000-0000-0000-0000-000000000003',
    'sub_english_priv',
    'top_sentence_corr',
    'Choose the grammatically correct sentence:',
    FALSE,
    '[{"id": "A", "text": "Neither the teacher nor the students was present."}, {"id": "B", "text": "Neither the teacher nor the students were present."}, {"id": "C", "text": "Neither the students nor the teacher were present."}, {"id": "D", "text": "Neither the teacher or the students was present."}]'::jsonb,
    'B',
    'When subjects are connected by "Neither... nor", the verb agrees with the closer subject ("students", which is plural), hence "were present".',
    '["Look at the subject-verb proximity rule for neither/nor.", "The noun closest to the verb determines singular or plural.", "Students is plural, so use were."]'::jsonb,
    1.3,
    ARRAY['NSU', 'BRACU', 'IUB', 'UIU'],
    ARRAY['engineering', 'business', 'pharmacy']
)
ON CONFLICT (id) DO NOTHING;
