import { Pool } from 'pg';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecordMistakesParams {
  userId: string | null | undefined;
  questionIds: Array<string | null | undefined>;
  universityCode?: string | null;
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

/**
 * Persists one or more wrong question attempts into public.mistake_vault.
 * Validates UUIDs and joins public.questions so synthetic/deleted IDs are safely ignored.
 */
export async function recordMistakesToVault(
  db: Pool,
  params: RecordMistakesParams,
): Promise<number> {
  const userId = typeof params.userId === 'string' ? params.userId.trim() : '';
  if (!UUID_REGEX.test(userId)) return 0;

  const uniqueIds = Array.from(
    new Set(
      (params.questionIds || [])
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter((id) => UUID_REGEX.test(id)),
    ),
  );
  if (uniqueIds.length === 0) return 0;

  const uCode = (params.universityCode || 'gen').trim().toLowerCase().slice(0, 32) || 'gen';

  try {
    const res = await db.query(
      `INSERT INTO public.mistake_vault (
         user_id, question_id, university_code, wrong_count, consecutive_correct,
         next_review_at, is_mastered, last_reviewed_at
       )
       SELECT $1::uuid, q.id, $2, 1, 0, NOW() + INTERVAL '1 day', false, NOW()
       FROM unnest($3::uuid[]) AS input_id
       JOIN public.questions q ON q.id = input_id
       ON CONFLICT (user_id, question_id) DO UPDATE SET
         wrong_count = mistake_vault.wrong_count + 1,
         consecutive_correct = 0,
         is_mastered = false,
         next_review_at = NOW() + INTERVAL '1 day',
         last_reviewed_at = NOW()`,
      [userId, uCode, uniqueIds],
    );
    return res.rowCount ?? 0;
  } catch (err) {
    params.log?.warn({ err, userId, count: uniqueIds.length }, 'Unable to record mistakes in mistake_vault');
    return 0;
  }
}
