import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createFixedWindowRateLimiter,
  normalizeRateLimitConfig,
  parseRateLimitPerMinute,
} from '../src/rate-limit.js';
import { createServer } from '../src/server.js';
import { readAuditEvents } from '../src/audit-log.js';

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function createRateLimitServer(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'linke-rate-limit-'));
  const server = createServer({
    dataDir,
    authToken: options.authToken,
    rateLimit: options.rateLimit,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    dataDir,
    server,
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

async function cleanupFixture(fixture) {
  if (!fixture) return;
  await closeServer(fixture.server);
  await rm(fixture.dataDir, { recursive: true, force: true });
}

async function getJSON(base, path, token) {
  return fetch(`${base}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe('rate-limit module', () => {
  it('allows maxRequests within a fixed window, rejects the next request, and resets after windowMs', () => {
    let now = 0;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 2,
      windowMs: 1000,
      now: () => now,
    });

    assert.deepEqual(limiter.check('client-a'), {
      allowed: true,
      limit: 2,
      remaining: 1,
      retryAfterMs: 0,
    });
    assert.deepEqual(limiter.check('client-a'), {
      allowed: true,
      limit: 2,
      remaining: 0,
      retryAfterMs: 0,
    });
    assert.deepEqual(limiter.check('client-a'), {
      allowed: false,
      limit: 2,
      remaining: 0,
      retryAfterMs: 1000,
    });

    now = 1001;
    assert.deepEqual(limiter.check('client-a'), {
      allowed: true,
      limit: 2,
      remaining: 1,
      retryAfterMs: 0,
    });
  });

  it('keeps different client keys isolated', () => {
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: () => 0,
    });

    assert.equal(limiter.check('client-a').allowed, true);
    assert.equal(limiter.check('client-a').allowed, false);
    assert.equal(limiter.check('client-b').allowed, true);
  });

  it('normalizes disabled and configured rate-limit options', () => {
    assert.equal(normalizeRateLimitConfig(undefined), null);
    assert.equal(normalizeRateLimitConfig(null), null);
    assert.deepEqual(normalizeRateLimitConfig({ maxRequests: 3, windowMs: 5000 }), {
      maxRequests: 3,
      windowMs: 5000,
      now: undefined,
    });
  });

  it('parses LINKE_RATE_LIMIT_PER_MINUTE values', () => {
    assert.equal(parseRateLimitPerMinute(undefined), null);
    assert.equal(parseRateLimitPerMinute(''), null);
    assert.equal(parseRateLimitPerMinute('0'), null);
    assert.deepEqual(parseRateLimitPerMinute('12'), {
      maxRequests: 12,
      windowMs: 60000,
    });

    for (const value of ['-1', '1.5', 'abc']) {
      assert.throws(
        () => parseRateLimitPerMinute(value),
        /LINKE_RATE_LIMIT_PER_MINUTE must be a non-negative integer/,
      );
    }
  });
});

describe('rate-limit API integration', () => {
  it('keeps default createServer behavior unlimited when rateLimit is not configured', async () => {
    const fixture = await createRateLimitServer();
    try {
      for (let i = 0; i < 3; i++) {
        const res = await getJSON(fixture.base, '/api/health');
        assert.equal(res.status, 200);
      }
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('returns 429 after the configured API request limit and allows again after the window resets', async () => {
    let now = 0;
    const fixture = await createRateLimitServer({
      rateLimit: { maxRequests: 2, windowMs: 1000, now: () => now },
    });
    try {
      assert.equal((await getJSON(fixture.base, '/api/health')).status, 200);
      assert.equal((await getJSON(fixture.base, '/api/health')).status, 200);
      const limited = await getJSON(fixture.base, '/api/health');
      assert.equal(limited.status, 429);
      assert.deepEqual(await limited.json(), { error: 'Rate limit exceeded' });

      now = 1001;
      assert.equal((await getJSON(fixture.base, '/api/health')).status, 200);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('returns 429 before auth state is disclosed and records an api.rate_limited audit event', async () => {
    let now = 0;
    const fixture = await createRateLimitServer({
      authToken: 'rate-token',
      rateLimit: { maxRequests: 1, windowMs: 1000, now: () => now },
    });
    try {
      const denied = await getJSON(fixture.base, '/api/health');
      assert.equal(denied.status, 401);

      const limited = await getJSON(fixture.base, '/api/health');
      assert.equal(limited.status, 429);
      assert.deepEqual(await limited.json(), { error: 'Rate limit exceeded' });

      now = 1001;
      const audit = await getJSON(fixture.base, '/api/audit-log?limit=10', 'rate-token');
      assert.equal(audit.status, 200);
      const body = await audit.json();
      const types = body.events.map((event) => event.type);
      assert.ok(types.includes('auth.denied'));
      assert.ok(types.includes('api.rate_limited'));
      assert.doesNotMatch(JSON.stringify(body.events), /rate-token|Authorization|Bearer/);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('does not rate-limit non-API routes', async () => {
    const fixture = await createRateLimitServer({
      rateLimit: { maxRequests: 1, windowMs: 1000, now: () => 0 },
    });
    try {
      assert.equal((await fetch(`${fixture.base}/`)).status, 200);
      assert.equal((await fetch(`${fixture.base}/`)).status, 200);
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
