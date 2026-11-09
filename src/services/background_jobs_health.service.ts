export type BackgroundJobStatus = 'not_configured' | 'starting' | 'healthy' | 'degraded';

export function aggregateBackgroundJobHealth(statuses: readonly BackgroundJobStatus[]): BackgroundJobStatus {
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.length > 0 && statuses.every((status) => status === 'healthy')) return 'healthy';
  return 'starting';
}
