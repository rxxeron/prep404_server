-- The roadmap RPC accepts a UUID for compatibility, but it must never allow
-- one authenticated learner to request another learner's progress.
CREATE OR REPLACE FUNCTION public.get_student_roadmap(p_user_id UUID, p_university_code VARCHAR)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_blueprint JSONB;
    v_sections JSONB;
    v_summit_score FLOAT := 0.0;
    v_milestones JSONB;
BEGIN
    IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Cannot access another learner roadmap';
    END IF;

    SELECT to_jsonb(b) INTO v_blueprint
    FROM public.university_blueprints b
    WHERE b.university_code = LOWER(p_university_code)
    LIMIT 1;

    IF v_blueprint IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'University blueprint not found');
    END IF;

    SELECT jsonb_agg(jsonb_build_object(
        'id', s.value->>'id',
        'title', s.value->>'title',
        'marks', (s.value->>'marks')::int,
        'weight', (s.value->>'weight')::float,
        'color_hex', s.value->>'color_hex',
        'progress', COALESCE(p.mastery_percentage, 0.0)
    )) INTO v_sections
    FROM jsonb_array_elements(v_blueprint->'sections') AS s
    LEFT JOIN public.student_section_progress p
        ON p.user_id = p_user_id
        AND p.university_code = LOWER(p_university_code)
        AND p.section_id = s.value->>'id';

    SELECT COALESCE(SUM((s.value->>'weight')::float * COALESCE(p.mastery_percentage, 0.0)), 0.0)
    INTO v_summit_score
    FROM jsonb_array_elements(v_blueprint->'sections') AS s
    LEFT JOIN public.student_section_progress p
        ON p.user_id = p_user_id
        AND p.university_code = LOWER(p_university_code)
        AND p.section_id = s.value->>'id';

    SELECT jsonb_agg(jsonb_build_object(
        'node_id', m.node_id,
        'status', m.status,
        'score', m.score_percentage
    )) INTO v_milestones
    FROM public.student_milestone_progress m
    WHERE m.user_id = p_user_id AND m.university_code = LOWER(p_university_code);

    RETURN jsonb_build_object(
        'success', true,
        'university_code', p_university_code,
        'blueprint', v_blueprint,
        'summit_score', ROUND(v_summit_score::numeric, 1),
        'sections', COALESCE(v_sections, '[]'::jsonb),
        'milestones', COALESCE(v_milestones, '[]'::jsonb)
    );
END;
$$;
