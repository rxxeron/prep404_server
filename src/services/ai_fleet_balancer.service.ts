import { Pool } from 'pg';

export interface FleetNodeState {
  name: string;
  baseUrl: string;
  preferredModel: string;
  isEnabled: boolean;
  priority: number;
  maxConcurrency: number;
  online: boolean;
  availableModels: string[];
  resolvedModel: string;
  inFlight: number;
  latencyMs: number;
  cooldownUntil: number;
  lastCheckedAt: string | null;
}

export class AiFleetBalancerService {
  private static instance: AiFleetBalancerService | null = null;
  private readonly db: Pool;
  private nodes: Map<string, FleetNodeState> = new Map();
  private probeTimer: NodeJS.Timeout | null = null;
  private isProbing = false;
  private initialized = false;

  private constructor(db: Pool) {
    this.db = db;
  }

  public static getInstance(db: Pool): AiFleetBalancerService {
    if (!AiFleetBalancerService.instance) {
      AiFleetBalancerService.instance = new AiFleetBalancerService(db);
    }
    return AiFleetBalancerService.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.reloadNodesFromDb();
    await this.probeAllNodes();

    this.probeTimer = setInterval(() => {
      this.reloadNodesFromDb()
        .then(() => this.probeAllNodes())
        .catch(() => undefined);
    }, 30_000);
    if (typeof this.probeTimer.unref === 'function') {
      this.probeTimer.unref();
    }
  }

  public async reloadNodesFromDb(): Promise<void> {
    const nextMap = new Map<string, FleetNodeState>();

    // 1. Optional ENV override (comma-separated URLs)
    const envRaw = (process.env.AI_FLEET_NODES || '').trim();
    if (envRaw.length > 0) {
      const urls = envRaw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
      for (const url of urls) {
        const name = url.replace(/^https?:\/\//i, '').split('.')[0] || url;
        const prev = this.nodes.get(name);
        nextMap.set(name, {
          name,
          baseUrl: url,
          preferredModel: process.env.AI_PREFERRED_MODEL || 'gemma4:12b',
          isEnabled: true,
          priority: 100,
          maxConcurrency: 2,
          online: prev?.online ?? false,
          availableModels: prev?.availableModels ?? [],
          resolvedModel: prev?.resolvedModel ?? (process.env.AI_PREFERRED_MODEL || 'gemma4:12b'),
          inFlight: prev?.inFlight ?? 0,
          latencyMs: prev?.latencyMs ?? 9999,
          cooldownUntil: prev?.cooldownUntil ?? 0,
          lastCheckedAt: prev?.lastCheckedAt ?? null,
        });
      }
    }

    // 2. Database fleet registry (public.ai_fleet_nodes)
    try {
      const res = await this.db.query(
        `SELECT name, base_url, preferred_model, is_enabled, priority, max_concurrency
         FROM public.ai_fleet_nodes
         WHERE is_enabled = true
         ORDER BY priority DESC, name ASC`,
      );
      for (const row of res.rows) {
        const name = String(row.name);
        const prev = this.nodes.get(name);
        if (nextMap.has(name)) continue;
        nextMap.set(name, {
          name,
          baseUrl: String(row.base_url).replace(/\/+$/, ''),
          preferredModel: String(row.preferred_model || 'gemma4:12b'),
          isEnabled: Boolean(row.is_enabled),
          priority: Number(row.priority) || 50,
          maxConcurrency: Math.max(1, Number(row.max_concurrency) || 2),
          online: prev?.online ?? false,
          availableModels: prev?.availableModels ?? [],
          resolvedModel: prev?.resolvedModel ?? String(row.preferred_model || 'gemma4:12b'),
          inFlight: prev?.inFlight ?? 0,
          latencyMs: prev?.latencyMs ?? 9999,
          cooldownUntil: prev?.cooldownUntil ?? 0,
          lastCheckedAt: prev?.lastCheckedAt ?? null,
        });
      }
    } catch (_) {
      // If DB table not ready yet, keep whatever nodes we already have
    }

    if (nextMap.size > 0) {
      this.nodes = nextMap;
    }
  }

  private resolveBestModel(preferred: string, models: string[]): string {
    if (models.length === 0) return preferred;
    const lowerPref = preferred.toLowerCase();
    const exact = models.find((m) => m.toLowerCase() === lowerPref);
    if (exact) return exact;

    const gemma4 = models.find((m) => m.toLowerCase().startsWith('gemma4'));
    if (gemma4) return gemma4;

    const gemmaAny = models.find((m) => m.toLowerCase().startsWith('gemma'));
    if (gemmaAny) return gemmaAny;

    const qwenText = models.find(
      (m) => m.toLowerCase().startsWith('qwen') && !m.toLowerCase().includes('vl'),
    );
    if (qwenText) return qwenText;

    return models[0];
  }

  public async probeAllNodes(): Promise<void> {
    if (this.isProbing) return;
    this.isProbing = true;
    try {
      const list = Array.from(this.nodes.values());
      const batchSize = 12;
      for (let i = 0; i < list.length; i += batchSize) {
        const batch = list.slice(i, i + batchSize);
        await Promise.all(batch.map((node) => this.probeSingleNode(node)));
      }
    } finally {
      this.isProbing = false;
    }
  }

  private async probeSingleNode(node: FleetNodeState): Promise<void> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);

    try {
      const res = await fetch(`${node.baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        node.online = false;
        node.lastCheckedAt = new Date().toISOString();
        return;
      }
      const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      const models = (data.models || [])
        .map((m) => String(m.name || m.model || '').trim())
        .filter(Boolean);

      node.online = models.length > 0;
      node.availableModels = models;
      node.resolvedModel = this.resolveBestModel(node.preferredModel, models);
      node.latencyMs = Date.now() - started;
      node.lastCheckedAt = new Date().toISOString();

      // Persist health telemetry asynchronously
      this.db
        .query(
          `UPDATE public.ai_fleet_nodes
           SET last_status = $2,
               last_latency_ms = $3,
               available_models = $4::jsonb,
               last_checked_at = now()
           WHERE name = $1`,
          [node.name, node.online ? 'online' : 'empty', node.latencyMs, JSON.stringify(models)],
        )
        .catch(() => undefined);
    } catch (_) {
      const wasOnline = node.online;
      node.online = false;
      node.lastCheckedAt = new Date().toISOString();
      if (wasOnline) {
        this.db
          .query(
            `UPDATE public.ai_fleet_nodes
             SET last_status = 'offline', last_checked_at = now()
             WHERE name = $1`,
            [node.name],
          )
          .catch(() => undefined);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Acquires the least-busy healthy Lab PC node.
   * If no node is currently marked online, triggers a quick refresh probe once.
   */
  public async acquireNode(excludeNames: Set<string> = new Set()): Promise<FleetNodeState | null> {
    await this.initialize();

    let candidates = this.getHealthyCandidates(excludeNames);
    if (candidates.length === 0) {
      await this.probeAllNodes();
      candidates = this.getHealthyCandidates(excludeNames);
    }
    if (candidates.length === 0) return null;

    // Sort by: (1) lowest active load ratio, (2) highest priority, (3) lowest latency
    candidates.sort((a, b) => {
      const loadA = a.inFlight / a.maxConcurrency;
      const loadB = b.inFlight / b.maxConcurrency;
      if (Math.abs(loadA - loadB) > 0.001) return loadA - loadB;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.latencyMs - b.latencyMs;
    });

    const chosen = candidates[0];
    chosen.inFlight += 1;
    return chosen;
  }

  private getHealthyCandidates(excludeNames: Set<string>): FleetNodeState[] {
    const now = Date.now();
    return Array.from(this.nodes.values()).filter(
      (n) =>
        n.isEnabled &&
        n.online &&
        !excludeNames.has(n.name) &&
        n.cooldownUntil <= now,
    );
  }

  public releaseNode(name: string, result: { ok: boolean; latencyMs?: number }): void {
    const node = this.nodes.get(name);
    if (!node) return;
    node.inFlight = Math.max(0, node.inFlight - 1);
    if (result.ok) {
      if (typeof result.latencyMs === 'number') {
        node.latencyMs = Math.round(node.latencyMs * 0.6 + result.latencyMs * 0.4);
      }
      node.cooldownUntil = 0;
    } else {
      // Short circuit-breaker cooldown so traffic shifts to healthy PCs immediately
      node.cooldownUntil = Date.now() + 45_000;
    }
  }

  public getStatusSnapshot() {
    const all = Array.from(this.nodes.values());
    const online = all.filter((n) => n.online);
    return {
      totalConfigured: all.length,
      onlineCount: online.length,
      activeRequests: all.reduce((sum, n) => sum + n.inFlight, 0),
      onlineNodes: online.map((n) => ({
        name: n.name,
        baseUrl: n.baseUrl,
        resolvedModel: n.resolvedModel,
        availableModels: n.availableModels,
        inFlight: n.inFlight,
        maxConcurrency: n.maxConcurrency,
        latencyMs: n.latencyMs,
        priority: n.priority,
        lastCheckedAt: n.lastCheckedAt,
      })),
    };
  }
}
