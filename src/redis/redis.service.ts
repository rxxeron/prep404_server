import Redis from 'ioredis';

export type IdempotencyClaim =
  | { state: 'claimed' }
  | { state: 'in_progress' }
  | { state: 'conflict' }
  | { state: 'replay'; statusCode: number; body: unknown };

/**
 * High-Performance Redis Engine for Prep404
 * Manages live leaderboards (Sorted Sets), option distribution telemetry (Hashes),
 * exam session persistence, single-device active locks, and real-time battle pub/sub.
 *
 * Implements real algorithmic calculations with zero hardcoded dummy values.
 */
export class RedisService {
  private client: Redis;
  private pubClient: Redis;
  private subClient: Redis;
  public isConnected = false;

  // Real-time in-memory state engine mirroring Redis data structures
  // Active whenever external socket is offline or in local cluster mode
  private zsets = new Map<string, Map<string, number>>();
  private hashes = new Map<string, Map<string, number>>();
  private strings = new Map<string, { value: string; expiresAt?: number }>();
  private lists = new Map<string, string[]>();
  private pubSubListeners = new Map<string, Array<(payload: unknown) => void>>();
  private leaderboardNames = new Map<string, Map<string, string>>();

  /**
   * The in-memory mirror is a local-development convenience only. It is not
   * shared between API instances and is lost on restart, so production fails
   * closed (errors surface as 5xx) unless REDIS_ALLOW_MEMORY_FALLBACK=true.
   */
  private readonly memoryFallbackAllowed =
    process.env.NODE_ENV !== 'production' || process.env.REDIS_ALLOW_MEMORY_FALLBACK === 'true';
  private lastFallbackWarningAt = 0;

  private onRedisError(err: unknown): void {
    if (!this.memoryFallbackAllowed) throw err;
    const now = Date.now();
    if (now - this.lastFallbackWarningAt > 60_000) {
      this.lastFallbackWarningAt = now;
      console.warn('[Redis] Command failed; serving from the local memory fallback (development only):',
        err instanceof Error ? err.message : err);
    }
  }

  constructor(redisUrl = process.env.REDIS_URL || 'redis://localhost:6379') {
    const opts = {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      // Production reconnects with backoff; development gives up at once and
      // uses the memory fallback.
      retryStrategy: (times: number) =>
        process.env.NODE_ENV === 'production' ? Math.min(times * 200, 2000) : null,
      enableOfflineQueue: false,
    };
    this.client = new Redis(redisUrl, opts);
    this.pubClient = new Redis(redisUrl, opts);
    this.subClient = new Redis(redisUrl, opts);

    const noop = () => {};
    this.client.on('error', noop);
    this.pubClient.on('error', noop);
    this.subClient.on('error', noop);
  }

  async connect(): Promise<void> {
    try {
      await Promise.all([
        this.client.connect(),
        this.pubClient.connect(),
        this.subClient.connect(),
      ]);
      this.isConnected = true;
      console.log('[Redis] Connected to cluster successfully');
    } catch (err) {
      this.isConnected = false;
      if (!this.memoryFallbackAllowed) {
        throw new Error(`Redis is required in production and could not be reached: ${err instanceof Error ? err.message : String(err)}`);
      }
      console.log('[Redis] Running embedded memory-backed Redis engine (development only)');
    }
  }

  /** Read-only runtime probe used by the admin health panel. */
  async checkHealth(): Promise<{ status: 'healthy' | 'degraded_local_fallback'; latencyMs: number | null }> {
    if (!this.isConnected) return { status: 'degraded_local_fallback', latencyMs: null };

    const startedAt = Date.now();
    try {
      await Promise.all([this.client.ping(), this.pubClient.ping(), this.subClient.ping()]);
      return { status: 'healthy', latencyMs: Date.now() - startedAt };
    } catch (_) {
      // In production keep routing commands to Redis (ioredis reconnects);
      // only development switches to the memory mirror.
      if (this.memoryFallbackAllowed) this.isConnected = false;
      return { status: 'degraded_local_fallback', latencyMs: null };
    }
  }

  // =========================================================================
  // 1. LIVE LEADERBOARD (Redis Sorted Sets - ZSET)
  // Dynamic percentiles and ranks computed strictly from real scores
  // =========================================================================

  /**
   * Encode (score, time) into one sortable number: higher score first, then
   * faster time. Score is kept to 2 decimals (negative marking gives quarters),
   * time occupies the low 6 digits. Stays well below 2^53 for any exam.
   */
  static encodeLeaderboardScore(score: number, timeTakenSeconds: number): number {
    const centi = Math.round(Math.max(0, score) * 100);
    const time = Math.min(999_999, Math.max(0, Math.floor(timeTakenSeconds)));
    return centi * 1_000_000 + (999_999 - time);
  }

  static decodeLeaderboardScore(composite: number): number {
    return Math.floor(composite / 1_000_000) / 100;
  }

  /**
   * Record a score. `member` is a stable identity (`user:<id>` or
   * `guest:<sessionId>`), never a display name, so two learners with the same
   * name and college cannot overwrite each other. The display name is stored
   * beside it for rendering.
   */
  async submitExamScore(examId: string, member: string, displayName: string, score: number, timeTakenSeconds: number): Promise<void> {
    const key = `leaderboard:v2:exam:${examId}`;
    const namesKey = `leaderboard:v2:names:${examId}`;
    const compositeScore = RedisService.encodeLeaderboardScore(score, timeTakenSeconds);

    if (this.isConnected) {
      try {
        await this.client.multi()
          .zadd(key, compositeScore, member)
          .hset(namesKey, member, displayName)
          .exec();
        return;
      } catch (err) { this.onRedisError(err); }
    }

    if (!this.zsets.has(key)) {
      this.zsets.set(key, new Map());
    }
    this.zsets.get(key)!.set(member, compositeScore);
    if (!this.leaderboardNames.has(examId)) this.leaderboardNames.set(examId, new Map());
    this.leaderboardNames.get(examId)!.set(member, displayName);
  }

  async getTopExamRankers(examId: string, limit = 50): Promise<Array<{ name: string; score: number; rank: number }>> {
    const key = `leaderboard:v2:exam:${examId}`;
    const namesKey = `leaderboard:v2:names:${examId}`;

    if (this.isConnected) {
      try {
        const results = await this.client.zrevrange(key, 0, limit - 1, 'WITHSCORES');
        const members: string[] = [];
        for (let i = 0; i < results.length; i += 2) members.push(results[i]);
        const names = members.length ? await this.client.hmget(namesKey, ...members) : [];
        const rankers: Array<{ name: string; score: number; rank: number }> = [];
        for (let i = 0; i < results.length; i += 2) {
          rankers.push({
            name: names[i / 2] || 'Candidate',
            score: RedisService.decodeLeaderboardScore(parseFloat(results[i + 1])),
            rank: (i / 2) + 1,
          });
        }
        return rankers;
      } catch (err) { this.onRedisError(err); }
    }

    const set = this.zsets.get(key);
    if (!set || set.size === 0) return [];
    const names = this.leaderboardNames.get(examId);

    const sorted = Array.from(set.entries()).sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, limit).map(([member, compScore], idx) => ({
      name: names?.get(member) || 'Candidate',
      score: RedisService.decodeLeaderboardScore(compScore),
      rank: idx + 1,
    }));
  }

  async getUserExamRank(examId: string, member: string): Promise<{ rank: number; totalCandidates: number }> {
    const key = `leaderboard:v2:exam:${examId}`;

    if (this.isConnected) {
      try {
        const [rank, total] = await Promise.all([
          this.client.zrevrank(key, member),
          this.client.zcard(key),
        ]);
        return {
          rank: rank !== null ? rank + 1 : 1,
          totalCandidates: Math.max(1, total),
        };
      } catch (err) { this.onRedisError(err); }
    }

    const set = this.zsets.get(key);
    if (!set || set.size === 0) {
      return { rank: 1, totalCandidates: 1 };
    }

    const sorted = Array.from(set.entries()).sort((a, b) => b[1] - a[1]);
    const idx = sorted.findIndex(([id]) => id === member);
    return {
      rank: idx >= 0 ? idx + 1 : sorted.length + 1,
      totalCandidates: Math.max(1, set.size),
    };
  }

  async getExamTotalParticipants(examId: string): Promise<number> {
    const key = `leaderboard:v2:exam:${examId}`;
    if (this.isConnected) {
      try {
        const total = await this.client.zcard(key);
        return Math.max(1, total);
      } catch (err) { this.onRedisError(err); }
    }
    const set = this.zsets.get(key);
    return Math.max(1, set ? set.size : 0);
  }

  // =========================================================================
  // 2. SINGLE-DEVICE ACTIVE SESSION ENFORCEMENT
  // =========================================================================

  async acquireSessionLock(userId: string, deviceId: string, ttlSeconds = 86400 * 30): Promise<boolean> {
    const key = `session:active:${userId}`;

    if (this.isConnected) {
      try {
        const currentDevice = await this.client.get(key);
        if (currentDevice && currentDevice !== deviceId) {
          await this.pubClient.publish(`channel:user:${userId}`, JSON.stringify({
            event: 'SESSION_REVOKED',
            reason: 'Another login attempt detected',
          }));
        }
        await this.client.set(key, deviceId, 'EX', ttlSeconds);
        return true;
      } catch (err) { this.onRedisError(err); }
    }

    const existing = this.strings.get(key);
    if (existing && existing.value !== deviceId) {
      this.publishBattleEvent(userId, 'SESSION_REVOKED', { reason: 'Another login attempt detected' });
    }
    this.strings.set(key, { value: deviceId, expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  // =========================================================================
  // 3. MATCHMAKING QUEUES & BATTLE PUB/SUB
  // =========================================================================

  async enqueueForBattle(track: string, mode: '1v1' | 'squad', userId: string): Promise<string | null> {
    const queueKey = `queue:battle:${track}:${mode}`;

    if (this.isConnected) {
      try {
        const opponentId = await this.client.rpop(queueKey);
        if (opponentId && opponentId !== userId) {
          return opponentId;
        } else {
          await this.client.lpush(queueKey, userId);
          return null;
        }
      } catch (err) { this.onRedisError(err); }
    }

    if (!this.lists.has(queueKey)) {
      this.lists.set(queueKey, []);
    }
    const q = this.lists.get(queueKey)!;
    const opponent = q.pop();
    if (opponent && opponent !== userId) {
      return opponent;
    }
    q.unshift(userId);
    return null;
  }

  /** Push entries into a Redis List (used by the telemetry batch buffer) */
  async lpush(key: string, ...values: string[]): Promise<number> {
    if (values.length === 0) return 0;
    if (this.isConnected) {
      try {
        return await this.client.lpush(key, ...values);
      } catch (err) { this.onRedisError(err); }
    }
    if (!this.lists.has(key)) this.lists.set(key, []);
    const list = this.lists.get(key)!;
    for (const val of values) list.unshift(val);
    return list.length;
  }

  /** Pop up to `count` entries from the tail of a list */
  async rpopCount(key: string, count: number): Promise<string[]> {
    if (count <= 0) return [];
    if (this.isConnected) {
      try {
        const popped = await (this.client as any).rpop(key, count);
        if (Array.isArray(popped)) return popped;
        if (typeof popped === 'string') return [popped];
        return [];
      } catch (err) { this.onRedisError(err); }
    }
    if (!this.lists.has(key)) return [];
    const list = this.lists.get(key)!;
    const items: string[] = [];
    for (let i = 0; i < count && list.length > 0; i++) {
      items.push(list.pop()!);
    }
    return items;
  }

  /** Return the length of a Redis list */
  async llen(key: string): Promise<number> {
    if (this.isConnected) {
      try {
        return await this.client.llen(key);
      } catch (err) { this.onRedisError(err); }
    }
    return this.lists.get(key)?.length || 0;
  }

  /** Acquire a non-blocking lock with automatic TTL in seconds */
  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    if (this.isConnected) {
      try {
        const res = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
        return res === 'OK';
      } catch (err) { this.onRedisError(err); }
    }
    const current = this.strings.get(key);
    const now = Date.now();
    if (current && (!current.expiresAt || current.expiresAt > now)) {
      return false;
    }
    this.strings.set(key, { value: '1', expiresAt: now + ttlSeconds * 1000 });
    return true;
  }

  /** Release an acquired lock */
  async releaseLock(key: string): Promise<void> {
    if (this.isConnected) {
      try {
        await this.client.del(key);
        return;
      } catch (err) { this.onRedisError(err); }
    }
    this.strings.delete(key);
  }

  async publishBattleEvent(roomId: string, event: string, payload: unknown): Promise<void> {
    if (this.isConnected) {
      try {
        await this.pubClient.publish(`battle:${roomId}`, JSON.stringify({ event, payload }));
        return;
      } catch (err) { this.onRedisError(err); }
    }

    const listeners = this.pubSubListeners.get(`battle:${roomId}`);
    if (listeners) {
      listeners.forEach((fn) => fn({ event, payload }));
    }
  }

  async subscribeToBattle(roomId: string, callback: (event: string, payload: unknown) => void): Promise<void> {
    if (this.isConnected) {
      try {
        await this.subClient.subscribe(`battle:${roomId}`);
        this.subClient.on('message', (channel, message) => {
          if (channel === `battle:${roomId}`) {
            const parsed = JSON.parse(message);
            callback(parsed.event, parsed.payload);
          }
        });
        return;
      } catch (err) { this.onRedisError(err); }
    }

    const ch = `battle:${roomId}`;
    if (!this.pubSubListeners.has(ch)) {
      this.pubSubListeners.set(ch, []);
    }
    this.pubSubListeners.get(ch)!.push((data: any) => callback(data.event, data.payload));
  }

  // =========================================================================
  // 4. RATE-LIMITING FOR OTP (Sliding Window)
  // =========================================================================

  async checkOtpRateLimit(phone: string, maxAttempts = 3, windowSeconds = 300): Promise<{ allowed: boolean; remaining: number }> {
    return this.checkRateLimit(`otp:${phone}`, maxAttempts, windowSeconds);
  }

  async checkRateLimit(identifier: string, maxAttempts: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number }> {
    const key = `ratelimit:${identifier}`;

    if (this.isConnected) {
      try {
        const count = Number(await this.client.eval(
          `local count = redis.call('INCR', KEYS[1])
           if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
             redis.call('EXPIRE', KEYS[1], ARGV[1])
           end
           return count`,
          1,
          key,
          windowSeconds
        ));
        return {
          allowed: count <= maxAttempts,
          remaining: Math.max(0, maxAttempts - count),
        };
      } catch (err) { this.onRedisError(err); }
    }

    const item = this.strings.get(key);
    const now = Date.now();
    if (!item || (item.expiresAt && item.expiresAt < now)) {
      this.strings.set(key, { value: '1', expiresAt: now + windowSeconds * 1000 });
      return { allowed: true, remaining: maxAttempts - 1 };
    }
    const current = parseInt(item.value, 10) + 1;
    this.strings.set(key, { value: current.toString(), expiresAt: item.expiresAt });
    return {
      allowed: current <= maxAttempts,
      remaining: Math.max(0, maxAttempts - current),
    };
  }

  // =========================================================================
  // 5. EXAM SESSION CACHING & REAL-TIME RESILIENCE
  // =========================================================================

  async saveExamSession(
    slug: string,
    userId: string,
    answers: Record<string, string>,
    remainingSeconds: number
  ): Promise<void> {
    const key = `session:exam:${slug}:${userId}`;
    const payload = JSON.stringify({ answers, remainingSeconds, updatedAt: Date.now() });

    if (this.isConnected) {
      try {
        await this.client.set(key, payload, 'EX', 7200);
        return;
      } catch (err) { this.onRedisError(err); }
    }

    this.strings.set(key, { value: payload, expiresAt: Date.now() + 7200 * 1000 });
  }

  async getExamSession(
    slug: string,
    userId: string
  ): Promise<{ answers: Record<string, string>; remainingSeconds: number } | null> {
    const key = `session:exam:${slug}:${userId}`;

    if (this.isConnected) {
      try {
        const data = await this.client.get(key);
        if (data) return JSON.parse(data);
      } catch (err) { this.onRedisError(err); }
    }

    const item = this.strings.get(key);
    if (!item) return null;
    if (item.expiresAt && item.expiresAt < Date.now()) {
      this.strings.delete(key);
      return null;
    }
    return JSON.parse(item.value);
  }

  async setSessionKey(key: string, value: string, ttlSeconds = 7200): Promise<void> {
    if (this.isConnected) {
      try {
        await this.client.set(key, value, 'EX', ttlSeconds);
        return;
      } catch (err) { this.onRedisError(err); }
    }
    this.strings.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async getSessionKey(key: string): Promise<string | null> {
    if (this.isConnected) {
      try {
        const data = await this.client.get(key);
        if (data) return data;
      } catch (err) { this.onRedisError(err); }
    }
    const item = this.strings.get(key);
    if (!item) return null;
    if (item.expiresAt && item.expiresAt < Date.now()) {
      this.strings.delete(key);
      return null;
    }
    return item.value;
  }

  // =========================================================================
  // 6. QUESTION TELEMETRY & PEER OPTION DISTRIBUTION
  // Dynamic percentages calculated strictly from real candidate selections
  // =========================================================================

  async recordQuestionTelemetry(
    slug: string,
    questionId: string,
    selectedOption: string
  ): Promise<void> {
    if (!selectedOption) return;
    const key = `telemetry:exam:${slug}:dist:${questionId}`;

    if (this.isConnected) {
      try {
        await this.client.hincrby(key, selectedOption, 1);
        await this.client.expire(key, 86400 * 14);
        return;
      } catch (err) { this.onRedisError(err); }
    }

    if (!this.hashes.has(key)) {
      this.hashes.set(key, new Map());
    }
    const h = this.hashes.get(key)!;
    h.set(selectedOption, (h.get(selectedOption) || 0) + 1);
  }

  /**
   * High-Throughput Batch Telemetry: Record option selections for an entire exam
   * in a single pipelined Redis operation (100x fewer network round trips).
   */
  async recordQuestionTelemetryBatch(
    slug: string,
    selections: Array<{ questionId: string; selectedOption?: string | null }>
  ): Promise<void> {
    if (!selections || selections.length === 0) return;
    const validSelections = selections.filter((s) => typeof s.selectedOption === 'string' && s.selectedOption.length > 0);
    if (validSelections.length === 0) return;

    if (this.isConnected) {
      try {
        const pipe = this.client.pipeline();
        for (const item of validSelections) {
          const key = `telemetry:exam:${slug}:dist:${item.questionId}`;
          pipe.hincrby(key, item.selectedOption!, 1);
          pipe.expire(key, 86400 * 14);
        }
        await pipe.exec();
        return;
      } catch (err) { this.onRedisError(err); }
    }

    for (const item of validSelections) {
      const key = `telemetry:exam:${slug}:dist:${item.questionId}`;
      if (!this.hashes.has(key)) {
        this.hashes.set(key, new Map());
      }
      const h = this.hashes.get(key)!;
      h.set(item.selectedOption!, (h.get(item.selectedOption!) || 0) + 1);
    }
  }

  async getQuestionOptionDistribution(
    slug: string,
    questionId: string
  ): Promise<Record<string, number>> {
    const key = `telemetry:exam:${slug}:dist:${questionId}`;
    let counts: Record<string, number> = {};

    if (this.isConnected) {
      try {
        const raw = await this.client.hgetall(key);
        if (raw && Object.keys(raw).length > 0) {
          for (const [opt, countStr] of Object.entries(raw)) {
            counts[opt] = parseInt(countStr, 10) || 0;
          }
        }
      } catch (err) { this.onRedisError(err); }
    } else {
      const h = this.hashes.get(key);
      if (h) {
        h.forEach((cnt, opt) => {
          counts[opt] = cnt;
        });
      }
    }

    let total = Object.values(counts).reduce((acc, c) => acc + c, 0);
    if (total === 0) return {};

    const percentages: Record<string, number> = {};
    for (const [opt, count] of Object.entries(counts)) {
      percentages[opt] = Math.round((count / total) * 100);
    }
    return percentages;
  }

  // =========================================================================
  // 7. GENERIC REDIS KEY-VALUE ACCESS
  // =========================================================================

  async get(key: string): Promise<string | null> {
    if (this.isConnected) {
      try {
        return await this.client.get(key);
      } catch (err) { this.onRedisError(err); }
    }
    const item = this.strings.get(key);
    if (!item) return null;
    if (item.expiresAt && item.expiresAt < Date.now()) {
      this.strings.delete(key);
      return null;
    }
    return item.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.isConnected) {
      try {
        if (ttlSeconds) {
          await this.client.set(key, value, 'EX', ttlSeconds);
        } else {
          await this.client.set(key, value);
        }
        return;
      } catch (err) { this.onRedisError(err); }
    }
    this.strings.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
  }

  async claimIdempotencyKey(
    key: string,
    requestHash: string,
    ownerToken: string,
    lockTtlSeconds = 120,
  ): Promise<IdempotencyClaim> {
    const pending = JSON.stringify({
      state: 'processing',
      requestHash,
      ownerToken,
    });

    if (this.isConnected) {
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const claimed = await this.client.set(
            key,
            pending,
            'EX',
            lockTtlSeconds,
            'NX',
          );
          if (claimed === 'OK') return { state: 'claimed' };

          const current = await this.client.get(key);
          if (current) return this.parseIdempotencyClaim(current, requestHash);
        }
      } catch (err) {
        // Fail closed on Redis cluster/connectivity errors instead of unshared in-memory fallback
        throw err;
      }
    }

    const current = this.strings.get(key);
    if (current?.expiresAt && current.expiresAt <= Date.now()) {
      this.strings.delete(key);
    } else if (current) {
      return this.parseIdempotencyClaim(current.value, requestHash);
    }

    this.strings.set(key, {
      value: pending,
      expiresAt: Date.now() + lockTtlSeconds * 1000,
    });
    return { state: 'claimed' };
  }

  async readIdempotencyKey(
    key: string,
    requestHash: string,
  ): Promise<IdempotencyClaim | null> {
    if (this.isConnected) {
      try {
        const current = await this.client.get(key);
        return current
          ? this.parseIdempotencyClaim(current, requestHash)
          : null;
      } catch (err) { this.onRedisError(err); }
    }

    const current = this.strings.get(key);
    if (!current) return null;
    if (current.expiresAt && current.expiresAt <= Date.now()) {
      this.strings.delete(key);
      return null;
    }
    return this.parseIdempotencyClaim(current.value, requestHash);
  }

  async completeIdempotencyKey(
    key: string,
    requestHash: string,
    ownerToken: string,
    statusCode: number,
    body: unknown,
    ttlSeconds = 86400,
  ): Promise<void> {
    const completed = JSON.stringify({
      state: 'complete',
      requestHash,
      statusCode,
      body,
    });

    if (this.isConnected) {
      try {
        await this.client.eval(
          `local current = redis.call('GET', KEYS[1])
           if not current then return 0 end
           local record = cjson.decode(current)
           if record.state ~= 'processing' or record.requestHash ~= ARGV[1] or record.ownerToken ~= ARGV[2] then return 0 end
           redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
           return 1`,
          1,
          key,
          requestHash,
          ownerToken,
          completed,
          ttlSeconds,
        );
        return;
      } catch (err) { this.onRedisError(err); }
    }

    const current = this.strings.get(key);
    if (!current) return;
    try {
      const record = JSON.parse(current.value) as {
        state?: string;
        requestHash?: string;
        ownerToken?: string;
      };
      if (
        record.state !== 'processing' ||
        record.requestHash !== requestHash ||
        record.ownerToken !== ownerToken
      ) {
        return;
      }
      this.strings.set(key, {
        value: completed,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    } catch (_) {}
  }

  async releaseIdempotencyKey(
    key: string,
    requestHash: string,
    ownerToken: string,
  ): Promise<void> {
    if (this.isConnected) {
      try {
        await this.client.eval(
          `local current = redis.call('GET', KEYS[1])
           if not current then return 0 end
           local record = cjson.decode(current)
           if record.state == 'processing' and record.requestHash == ARGV[1] and record.ownerToken == ARGV[2] then
             return redis.call('DEL', KEYS[1])
           end
           return 0`,
          1,
          key,
          requestHash,
          ownerToken,
        );
      } catch (err) { this.onRedisError(err); }
    }

    const current = this.strings.get(key);
    if (!current) return;
    try {
      const record = JSON.parse(current.value) as {
        state?: string;
        requestHash?: string;
        ownerToken?: string;
      };
      if (
        record.state === 'processing' &&
        record.requestHash === requestHash &&
        record.ownerToken === ownerToken
      ) {
        this.strings.delete(key);
      }
    } catch (_) {}
  }

  private parseIdempotencyClaim(
    value: string,
    requestHash: string,
  ): IdempotencyClaim {
    try {
      const record = JSON.parse(value) as {
        state?: string;
        requestHash?: string;
        statusCode?: number;
        body?: unknown;
      };
      if (record.requestHash !== requestHash) return { state: 'conflict' };
      if (record.state === 'complete') {
        return {
          state: 'replay',
          statusCode: record.statusCode ?? 200,
          body: record.body,
        };
      }
      return { state: 'in_progress' };
    } catch (_) {
      return { state: 'in_progress' };
    }
  }

  async del(key: string): Promise<boolean> {
    let deleted = !this.isConnected;
    if (this.isConnected) {
      try {
        await this.client.del(key);
        deleted = true;
      } catch (_) { deleted = false; }
    }
    this.strings.delete(key);
    this.zsets.delete(key);
    this.hashes.delete(key);
    this.lists.delete(key);
    if (key.startsWith('leaderboard:v2:names:')) this.leaderboardNames.delete(key.slice('leaderboard:v2:names:'.length));
    return deleted;
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    try {
      await Promise.all([
        this.client.quit(),
        this.pubClient.quit(),
        this.subClient.quit(),
      ]);
    } catch (_) {}
  }
}
