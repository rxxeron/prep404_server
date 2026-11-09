import { Pool } from 'pg';
import { RedisService } from '../redis/redis.service';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'crash';
export type LogSource = 'app' | 'server' | 'auth' | 'exam' | 'battle' | 'network' | 'system';

export interface SystemLogEntry {
  occurredAt?: string;
  level: LogLevel;
  source: LogSource;
  userId?: string | null;
  event: string;
  message?: string | null;
  errorStack?: string | null;
  metadata?: Record<string, unknown>;
}

const REDIS_LOG_QUEUE = 'logs:system:buffer';
const REDIS_FLUSH_LOCK = 'logs:system:flush_lock';
const BATCH_SIZE_THRESHOLD = 500;
const FLUSH_INTERVAL_MS = 30_000; // 30 seconds

export class TelemetryBatchService {
  private static instance: TelemetryBatchService | null = null;
  private db: Pool;
  private redis: RedisService;
  private timer: NodeJS.Timeout | null = null;
  private isFlushing = false;

  constructor(db: Pool, redis: RedisService) {
    this.db = db;
    this.redis = redis;
  }

  public static initialize(db: Pool, redis: RedisService): TelemetryBatchService {
    if (!TelemetryBatchService.instance) {
      TelemetryBatchService.instance = new TelemetryBatchService(db, redis);
      TelemetryBatchService.instance.startWorker();
    }
    return TelemetryBatchService.instance;
  }

  public static getInstance(): TelemetryBatchService | null {
    return TelemetryBatchService.instance;
  }

  public startWorker(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        console.warn('[Telemetry Batch] Scheduled flush encountered error:', err instanceof Error ? err.message : err);
      });
    }, FLUSH_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  public stopWorker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Enqueue a single log item into the Redis buffer.
   * Fatal errors and crashes trigger an immediate flush.
   */
  public async enqueue(entry: SystemLogEntry): Promise<void> {
    const serialized = JSON.stringify({
      occurredAt: entry.occurredAt || new Date().toISOString(),
      level: entry.level,
      source: entry.source,
      userId: entry.userId || null,
      event: entry.event,
      message: entry.message || null,
      errorStack: entry.errorStack || null,
      metadata: entry.metadata || {},
    });

    const queueLen = await this.redis.lpush(REDIS_LOG_QUEUE, serialized);

    // Fatal crashes or large buffer bypass interval and flush immediately
    if (entry.level === 'fatal' || entry.level === 'crash' || queueLen >= BATCH_SIZE_THRESHOLD) {
      setImmediate(() => {
        this.flush().catch(() => {});
      });
    }
  }

  /**
   * Enqueue multiple logs from client in one operation.
   */
  public async enqueueBatch(entries: SystemLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const serialized = entries.map((entry) =>
      JSON.stringify({
        occurredAt: entry.occurredAt || new Date().toISOString(),
        level: entry.level,
        source: entry.source,
        userId: entry.userId || null,
        event: entry.event,
        message: entry.message || null,
        errorStack: entry.errorStack || null,
        metadata: entry.metadata || {},
      })
    );

    const queueLen = await this.redis.lpush(REDIS_LOG_QUEUE, ...serialized);

    const hasFatal = entries.some((e) => e.level === 'fatal' || e.level === 'crash');
    if (hasFatal || queueLen >= BATCH_SIZE_THRESHOLD) {
      setImmediate(() => {
        this.flush().catch(() => {});
      });
    }
  }

  /**
   * Pop up to `chunkSize` logs from Redis and batch-insert into Supabase PostgreSQL.
   */
  public async flush(chunkSize = 1000): Promise<number> {
    if (this.isFlushing) return 0;

    const locked = await this.redis.acquireLock(REDIS_FLUSH_LOCK, 20);
    if (!locked) return 0;

    this.isFlushing = true;
    try {
      const rawEntries = await this.redis.rpopCount(REDIS_LOG_QUEUE, chunkSize);
      if (rawEntries.length === 0) {
        return 0;
      }

      const rows: Array<{
        occurredAt: string;
        level: string;
        source: string;
        userId: string | null;
        event: string;
        message: string | null;
        errorStack: string | null;
        metadata: string;
      }> = [];

      for (const raw of rawEntries) {
        try {
          const parsed = JSON.parse(raw);
          rows.push({
            occurredAt: parsed.occurredAt,
            level: parsed.level,
            source: parsed.source,
            userId: parsed.userId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.userId) ? parsed.userId : null,
            event: parsed.event,
            message: parsed.message,
            errorStack: parsed.errorStack,
            metadata: JSON.stringify(parsed.metadata || {}),
          });
        } catch (_) {}
      }

      if (rows.length === 0) return 0;

      // Construct multi-row parameterized batch insert
      const valueTuples: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      for (const row of rows) {
        valueTuples.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}::jsonb)`);
        values.push(
          row.occurredAt,
          row.level,
          row.source,
          row.userId,
          row.event,
          row.message,
          row.errorStack,
          row.metadata
        );
      }

      const sql = `
        INSERT INTO public.app_system_logs (
          occurred_at, level, source, user_id, event, message, error_stack, metadata
        ) VALUES ${valueTuples.join(', ')}
      `;

      await this.db.query(sql, values);

      // If the buffer still has unprocessed backlog, trigger another cycle
      const remaining = await this.redis.llen(REDIS_LOG_QUEUE);
      if (remaining >= BATCH_SIZE_THRESHOLD) {
        setImmediate(() => {
          this.flush().catch(() => {});
        });
      }

      return rows.length;
    } catch (err) {
      console.error('[Telemetry Batch] Batch write to Supabase failed:', err instanceof Error ? err.message : err);
      return 0;
    } finally {
      this.isFlushing = false;
      await this.redis.releaseLock(REDIS_FLUSH_LOCK);
    }
  }
}
