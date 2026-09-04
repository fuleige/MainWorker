import assert from 'node:assert/strict';
import test from 'node:test';
import { RATE_LIMIT_CACHE_TTL_MS, RATE_LIMIT_MANUAL_COOLDOWN_MS, RateLimitService } from '../server/rate-limits.js';

function snapshot(usedPercent) {
  return {
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent, windowDurationMins: 300, resetsAt: 2_000_000_000 },
    },
  };
}

test('rate-limit reads use the ten-minute cache and enforce manual cooldown', async () => {
  let now = 1_000_000;
  let reads = 0;
  const service = new RateLimitService({
    now: () => now,
    readRemote: async () => snapshot(++reads * 10),
  });

  const first = await service.read();
  assert.equal(reads, 1);
  assert.equal(first.cached, false);

  const cached = await service.read();
  assert.equal(reads, 1);
  assert.equal(cached.cached, true);

  await service.read({ force: true });
  assert.equal(reads, 1, 'manual refresh inside cooldown must not reach Codex');

  now += RATE_LIMIT_MANUAL_COOLDOWN_MS;
  const forced = await service.read({ force: true });
  assert.equal(reads, 2);
  assert.equal(forced.cached, false);

  now += RATE_LIMIT_CACHE_TTL_MS - 1;
  await service.read();
  assert.equal(reads, 2, 'normal reads remain cached until TTL expires');

  now += 1;
  await service.read();
  assert.equal(reads, 3);
});

test('concurrent rate-limit reads are coalesced into one Codex request', async () => {
  let reads = 0;
  let release;
  const remote = new Promise((resolve) => { release = resolve; });
  const service = new RateLimitService({ readRemote: () => { reads += 1; return remote; } });

  const first = service.read();
  const second = service.read();
  assert.equal(reads, 1);
  release(snapshot(25));
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.snapshot, b.snapshot);
  assert.equal(reads, 1);
});

test('a partial push update does not prevent the first complete rate-limit read', async () => {
  let reads = 0;
  const service = new RateLimitService({ readRemote: async () => { reads += 1; return snapshot(40); } });
  service.applyUpdate({ limitId: 'codex', primary: { usedPercent: 35 } });

  const result = await service.read();
  assert.equal(reads, 1);
  assert.equal(result.snapshot.rateLimits.primary.usedPercent, 40);
});

test('failed refresh keeps the last snapshot and reports it as stale', async () => {
  let now = 2_000_000;
  let fail = false;
  const service = new RateLimitService({
    now: () => now,
    readRemote: async () => {
      if (fail) throw new Error('temporary failure');
      return snapshot(20);
    },
  });

  await service.read();
  now += RATE_LIMIT_CACHE_TTL_MS;
  fail = true;
  const fallback = await service.read();
  assert.equal(fallback.cached, true);
  assert.equal(fallback.stale, true);
  assert.equal(fallback.refreshError, 'temporary failure');
  assert.equal(fallback.snapshot.rateLimits.primary.usedPercent, 20);
});
