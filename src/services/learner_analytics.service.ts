import { Pool } from 'pg';

export type LearnerEvent = 'analytics_consent_granted' | 'app_open' | 'onboarding_completed' | 'practice_attempted' | 'exam_submitted';

export type LearnerClientContext = { deviceType?: 'android' | 'ios' | 'web' | 'other'; appVersion?: string; locale?: string };

export async function recordLearnerEvent(db: Pool, userId: string, eventName: LearnerEvent, context: LearnerClientContext = {}): Promise<void> {
  await db.query(`INSERT INTO public.learner_analytics_events (user_id, event_name, device_type, app_version, locale)
    SELECT $1::uuid, $2, CASE WHEN $2='app_open' THEN $3 ELSE NULL END,
      CASE WHEN $2='app_open' THEN $4 ELSE NULL END, CASE WHEN $2='app_open' THEN $5 ELSE NULL END
    FROM (
      SELECT COALESCE(
        (SELECT enabled FROM public.learner_analytics_consent WHERE user_id=$1::uuid),
        true
      ) AS enabled
    ) consent
    WHERE consent.enabled = true
    ON CONFLICT DO NOTHING`, [userId, eventName, context.deviceType ?? null, context.appVersion ?? null, context.locale ?? null]);
}

export async function purgeExpiredLearnerEvents(db: Pool): Promise<number> {
  const [events, tutorUsage] = await Promise.all([
    db.query(`DELETE FROM public.learner_analytics_events WHERE expires_at <= now()`),
    db.query(`DELETE FROM public.ai_tutor_usage_daily WHERE event_day < current_date-INTERVAL '12 months'`),
  ]);
  return (events.rowCount || 0) + (tutorUsage.rowCount || 0);
}

type RetentionState = { status: 'starting' | 'healthy' | 'degraded'; lastAttemptAt: string | null; lastSuccessAt: string | null; lastDeleted: number | null };
let state: RetentionState = { status: 'starting', lastAttemptAt: null, lastSuccessAt: null, lastDeleted: null };
export const getLearnerAnalyticsRetentionState = (): RetentionState => ({ ...state });

export function startLearnerAnalyticsRetentionJob(db: Pool, onError: (error: unknown) => void): NodeJS.Timeout {
  const run = async () => {
    state = { ...state, status: 'starting', lastAttemptAt: new Date().toISOString() };
    try {
      const deleted = await purgeExpiredLearnerEvents(db);
      state = { status: 'healthy', lastAttemptAt: state.lastAttemptAt, lastSuccessAt: new Date().toISOString(), lastDeleted: deleted };
    } catch (error) { state = { ...state, status: 'degraded' }; onError(error); }
  };
  void run();
  const timer = setInterval(() => { void run(); }, 6 * 60 * 60 * 1000);
  timer.unref();
  return timer;
}
