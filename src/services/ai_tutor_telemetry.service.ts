import { Pool } from 'pg';

export type AiTutorOutcome = 'success' | 'no_hint' | 'not_found' | 'failure' | 'rate_limited' | 'invalid_request';

/** Store non-identifying daily operational totals; never persist prompt or answer content. */
export async function recordAiTutorUsage(db: Pool, outcome: AiTutorOutcome, latencyMs: number): Promise<void> {
  const boundedLatency = Math.max(0, Math.min(2_147_483_647, Math.round(latencyMs)));
  await db.query(`INSERT INTO public.ai_tutor_usage_daily (
      event_day, request_count, success_count, no_hint_count, not_found_count,
      failure_count, rate_limited_count, invalid_request_count,
      latency_total_ms, latency_max_ms, provider_cost_microusd
    ) VALUES (
      (now() AT TIME ZONE 'UTC')::date, 1,
      ($1::text='success')::int, ($1::text='no_hint')::int, ($1::text='not_found')::int,
      ($1::text='failure')::int, ($1::text='rate_limited')::int, ($1::text='invalid_request')::int,
      $2::bigint, $2::integer, 0
    )
    ON CONFLICT (event_day) DO UPDATE SET
      request_count = ai_tutor_usage_daily.request_count + EXCLUDED.request_count,
      success_count = ai_tutor_usage_daily.success_count + EXCLUDED.success_count,
      no_hint_count = ai_tutor_usage_daily.no_hint_count + EXCLUDED.no_hint_count,
      not_found_count = ai_tutor_usage_daily.not_found_count + EXCLUDED.not_found_count,
      failure_count = ai_tutor_usage_daily.failure_count + EXCLUDED.failure_count,
      rate_limited_count = ai_tutor_usage_daily.rate_limited_count + EXCLUDED.rate_limited_count,
      invalid_request_count = ai_tutor_usage_daily.invalid_request_count + EXCLUDED.invalid_request_count,
      latency_total_ms = ai_tutor_usage_daily.latency_total_ms + EXCLUDED.latency_total_ms,
      latency_max_ms = GREATEST(ai_tutor_usage_daily.latency_max_ms, EXCLUDED.latency_max_ms),
      updated_at = now()`, [outcome, boundedLatency]);
}
