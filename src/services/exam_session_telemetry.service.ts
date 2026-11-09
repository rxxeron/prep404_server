import { createHash } from 'crypto';
import { Pool } from 'pg';

const FAILURE_CODES = new Set(['suspicious_speed', 'persistence_failed', 'request_failed']);

export const hashExamSessionId = (sessionId: string): string =>
  createHash('sha256').update(sessionId).digest('hex');

export async function recordExamSessionStart(db: Pool, examId: string, sessionId: string, source: 'public' | 'dynamic'): Promise<void> {
  await db.query(`INSERT INTO public.exam_session_telemetry (session_hash, exam_id, source)
    VALUES ($1, $2::uuid, $3) ON CONFLICT (session_hash) DO NOTHING`, [hashExamSessionId(sessionId), examId, source]);
}

export async function recordExamSessionCompletion(db: Pool, examId: string, sessionId: string): Promise<void> {
  await db.query(`UPDATE public.exam_session_telemetry SET submitted_at = now()
    WHERE session_hash = $1 AND exam_id = $2::uuid AND submitted_at IS NULL`, [hashExamSessionId(sessionId), examId]);
}

export async function recordExamSessionFailure(db: Pool, examId: string, sessionId: string, code: string): Promise<void> {
  const safeCode = FAILURE_CODES.has(code) ? code : 'request_failed';
  await db.query(`UPDATE public.exam_session_telemetry SET
    failure_count = LEAST(failure_count + 1, 100), last_failure_at = now(), last_failure_code = $3
    WHERE session_hash = $1 AND exam_id = $2::uuid`, [hashExamSessionId(sessionId), examId, safeCode]);
}

export async function purgeExpiredExamSessions(db: Pool): Promise<number> {
  const result = await db.query(`DELETE FROM public.exam_session_telemetry WHERE started_at < now() - INTERVAL '30 days'`);
  return result.rowCount || 0;
}

type RetentionJobState = {
  status: 'not_configured' | 'starting' | 'healthy' | 'degraded';
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastDeleted: number | null;
};

let retentionJobState: RetentionJobState = {
  status: 'not_configured',
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastDeleted: null,
};

export const getExamSessionRetentionState = (): RetentionJobState => ({ ...retentionJobState });

export function startExamSessionRetentionJob(db: Pool, onError: (error: unknown) => void): NodeJS.Timeout {
  const run = async () => {
    retentionJobState = { ...retentionJobState, status: 'starting', lastAttemptAt: new Date().toISOString() };
    try {
      const deleted = await purgeExpiredExamSessions(db);
      retentionJobState = {
        status: 'healthy',
        lastAttemptAt: retentionJobState.lastAttemptAt,
        lastSuccessAt: new Date().toISOString(),
        lastDeleted: deleted,
      };
    } catch (error) {
      retentionJobState = { ...retentionJobState, status: 'degraded' };
      onError(error);
    }
  };

  void run();
  const timer = setInterval(() => { void run(); }, 6 * 60 * 60 * 1000);
  timer.unref();
  return timer;
}

