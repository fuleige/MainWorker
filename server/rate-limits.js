export const RATE_LIMIT_CACHE_TTL_MS = 10 * 60 * 1000;
export const RATE_LIMIT_MANUAL_COOLDOWN_MS = 60 * 1000;

function mergePresent(previous, incoming) {
  if (!incoming) return previous ?? null;
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}

function mergeRateLimit(previous, incoming) {
  if (!incoming) return previous ?? null;
  return {
    ...mergePresent(previous, incoming),
    primary: mergePresent(previous?.primary, incoming.primary),
    secondary: mergePresent(previous?.secondary, incoming.secondary),
    credits: mergePresent(previous?.credits, incoming.credits),
    individualLimit: mergePresent(previous?.individualLimit, incoming.individualLimit),
  };
}

export class RateLimitService {
  constructor({ readRemote, now = () => Date.now(), cacheTtlMs = RATE_LIMIT_CACHE_TTL_MS, manualCooldownMs = RATE_LIMIT_MANUAL_COOLDOWN_MS }) {
    this.readRemote = readRemote;
    this.now = now;
    this.cacheTtlMs = cacheTtlMs;
    this.manualCooldownMs = manualCooldownMs;
    this.cache = null;
    this.readInFlight = null;
    this.lastRemoteReadAt = 0;
  }

  response(cached, refreshError = null) {
    const now = this.now();
    return {
      snapshot: this.cache.snapshot,
      fetchedAt: new Date(this.cache.updatedAt).toISOString(),
      nextRefreshAt: new Date(this.cache.updatedAt + this.cacheTtlMs).toISOString(),
      refreshAllowedAt: new Date(Math.max(now, this.lastRemoteReadAt + this.manualCooldownMs)).toISOString(),
      cached,
      stale: now >= this.cache.updatedAt + this.cacheTtlMs,
      refreshError,
      policy: {
        cacheTtlMs: this.cacheTtlMs,
        manualCooldownMs: this.manualCooldownMs,
        polling: false,
      },
    };
  }

  async read({ force = false } = {}) {
    const now = this.now();
    const cacheFresh = this.cache?.complete && now < this.cache.updatedAt + this.cacheTtlMs;
    const manualCoolingDown = this.cache && now < this.lastRemoteReadAt + this.manualCooldownMs;
    if (this.cache && (cacheFresh && !force || force && manualCoolingDown)) return this.response(true);
    if (this.readInFlight) return this.readInFlight;

    this.lastRemoteReadAt = now;
    this.readInFlight = this.readRemote()
      .then((snapshot) => {
        this.cache = { snapshot, updatedAt: this.now(), complete: true };
        return this.response(false);
      })
      .catch((error) => {
        if (!this.cache) throw error;
        return this.response(true, error instanceof Error ? error.message : '额度刷新失败');
      })
      .finally(() => {
        this.readInFlight = null;
      });
    return this.readInFlight;
  }

  applyUpdate(incoming) {
    if (!incoming) return;
    const now = this.now();
    const previous = this.cache?.snapshot || {};
    const limitId = incoming.limitId || previous.rateLimits?.limitId || null;
    const previousById = previous.rateLimitsByLimitId || {};
    const previousLimit = limitId ? previousById[limitId] : previous.rateLimits;
    const updatedLimit = mergeRateLimit(previousLimit || previous.rateLimits, incoming);
    const nextById = { ...previousById };
    if (limitId) nextById[limitId] = updatedLimit;
    const replacesPrimary = !previous.rateLimits || !limitId || previous.rateLimits.limitId === limitId;
    this.cache = {
      snapshot: {
        ...previous,
        rateLimits: replacesPrimary ? updatedLimit : previous.rateLimits,
        rateLimitsByLimitId: Object.keys(nextById).length ? nextById : null,
      },
      updatedAt: now,
      complete: this.cache?.complete === true,
    };
  }
}
