function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeRateLimitConfig(rateLimit) {
  if (rateLimit === undefined || rateLimit === null || rateLimit === false) return null;
  if (typeof rateLimit !== 'object' || Array.isArray(rateLimit)) {
    throw new Error('rateLimit must be an object when provided');
  }

  const maxRequests = positiveInteger(rateLimit.maxRequests);
  if (!maxRequests) throw new Error('rateLimit.maxRequests must be a positive integer');

  const windowMs = positiveInteger(rateLimit.windowMs);
  if (!windowMs) throw new Error('rateLimit.windowMs must be a positive integer');

  if (rateLimit.now !== undefined && typeof rateLimit.now !== 'function') {
    throw new Error('rateLimit.now must be a function when provided');
  }

  return {
    maxRequests,
    windowMs,
    now: rateLimit.now,
  };
}

export function parseRateLimitPerMinute(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const maxRequests = Number(raw);
  if (!Number.isInteger(maxRequests) || maxRequests < 0) {
    throw new Error('LINKE_RATE_LIMIT_PER_MINUTE must be a non-negative integer');
  }
  if (maxRequests === 0) return null;
  return { maxRequests, windowMs: 60_000 };
}

export function createFixedWindowRateLimiter(rateLimit) {
  const config = normalizeRateLimitConfig(rateLimit);
  if (!config) return null;

  const buckets = new Map();
  const now = config.now || Date.now;

  return {
    check(clientKey = 'unknown') {
      const currentTime = Number(now());
      const safeNow = Number.isFinite(currentTime) ? currentTime : Date.now();
      const windowStart = Math.floor(safeNow / config.windowMs) * config.windowMs;
      const existing = buckets.get(clientKey);
      const bucket = existing && existing.windowStart === windowStart
        ? existing
        : { windowStart, count: 0 };

      if (bucket.count >= config.maxRequests) {
        return {
          allowed: false,
          limit: config.maxRequests,
          remaining: 0,
          retryAfterMs: Math.max(0, bucket.windowStart + config.windowMs - safeNow),
        };
      }

      bucket.count += 1;
      buckets.set(clientKey, bucket);
      return {
        allowed: true,
        limit: config.maxRequests,
        remaining: Math.max(0, config.maxRequests - bucket.count),
        retryAfterMs: 0,
      };
    },
  };
}
