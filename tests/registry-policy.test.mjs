import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRegistry } from '../src/sentinel/registry-policy.mjs';

const CFG = {
  registry: {
    cacheTtlHours: 1,
    minAgeDays: 14,
    minWeeklyDownloads: 100,
    requireHomepage: true,
    timeoutMs: 250,
  },
  ecosystems: { npm: true, pypi: true, crates: true },
};

const NOW = Date.now();

// Stub that returns 'ok' with a well-established package metadata shape.
function okFetch(meta) {
  return async () => ({ ok: true, status: 200,
    json: async () => ({ ...meta }) });
}

// Stub that returns HTTP 404.
function notFoundFetch() {
  return async () => ({ ok: false, status: 404, json: async () => ({}) });
}

// Stub that throws (network error / timeout).
function errorFetch() {
  return async () => { throw new Error('network error'); };
}

test('deny — package not found in registry (404)', async () => {
  // Stub fetchPackageMetadata behaviour via fetchFn that returns 404.
  // We supply a fetchFn that registry-clients will receive; the stub must
  // match the URL-calling contract: fetchFn(url, options) -> Response-like.
  let callCount = 0;
  const fetchFn = async (_url, _opts) => {
    callCount++;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const cache = {};
  const r = await evaluateRegistry({
    command: 'npm install slopsquat-pkg-xyz',
    config: CFG,
    fetchFn,
    cache,
    now: NOW,
  });
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'registry.not_found');
  assert.ok(r.matched, 'matched should be set to the package name');
  assert.ok(r.reason, 'reason should be a non-empty string');
  assert.ok(callCount >= 1, 'fetchFn must have been called at least once');
});

test('ask — package is too new (ageDays < minAgeDays)', async () => {
  const fetchFn = async (_url, _opts) => ({
    ok: true, status: 200,
    json: async () => ({
      // npm registry shape normalised by registry-clients to meta
      // The stub must return whatever shape registry-clients.fetchNpm produces
      // before normalisation; test that the policy layer interprets it correctly.
      // We simulate this by making the fetchFn return a shape that registry-clients
      // will normalise to { ageDays: 3, weeklyDownloads: 5000, hasHomepage: true, hasRepository: true }.
      // The exact shape depends on spec-03's normaliser; the test confirms policy behaviour.
      time: { created: new Date(NOW - 3 * 86_400_000).toISOString() },
      downloads: { weekly: 5000 },
      homepage: 'https://example.com',
      repository: { url: 'https://github.com/x/y' },
    }),
  });
  const cache = {};
  const r = await evaluateRegistry({
    command: 'npm install brand-new-pkg',
    config: CFG,
    fetchFn,
    cache,
    now: NOW,
  });
  assert.equal(r.decision, 'ask');
  assert.equal(r.rule, 'registry.too_new');
  assert.ok(r.reason);
});

test('ask — package has low weekly downloads', async () => {
  const fetchFn = async (url, _opts) => {
    if (url.includes('api.npmjs.org/downloads')) {
      return { ok: true, status: 200, json: async () => ({ downloads: 5 }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        time: { created: new Date(NOW - 60 * 86_400_000).toISOString() },
        homepage: 'https://example.com',
        repository: { url: 'https://github.com/x/y' },
      }),
    };
  };
  const cache = {};
  const r = await evaluateRegistry({
    command: 'npm install obscure-pkg',
    config: CFG,
    fetchFn,
    cache,
    now: NOW,
  });
  assert.equal(r.decision, 'ask');
  assert.equal(r.rule, 'registry.low_downloads');
  assert.ok(r.reason);
});

test('ask — package has no homepage or repository', async () => {
  const fetchFn = async (_url, _opts) => ({
    ok: true, status: 200,
    json: async () => ({
      time: { created: new Date(NOW - 60 * 86_400_000).toISOString() },
      downloads: { weekly: 5000 },
      homepage: null,
      repository: null,
    }),
  });
  const cache = {};
  const r = await evaluateRegistry({
    command: 'npm install no-source-pkg',
    config: CFG,
    fetchFn,
    cache,
    now: NOW,
  });
  assert.equal(r.decision, 'ask');
  assert.equal(r.rule, 'registry.no_source');
  assert.ok(r.reason);
});

test('allow — widely-used package passes all checks', async () => {
  const fetchFn = async (_url, _opts) => ({
    ok: true, status: 200,
    json: async () => ({
      time: { created: new Date(NOW - 365 * 86_400_000).toISOString() },
      downloads: { weekly: 1_000_000 },
      homepage: 'https://lodash.com',
      repository: { url: 'https://github.com/lodash/lodash' },
    }),
  });
  const cache = {};
  const r = await evaluateRegistry({
    command: 'npm install lodash',
    config: CFG,
    fetchFn,
    cache,
    now: NOW,
  });
  assert.equal(r.decision, 'allow');
  assert.equal(r.rule, null);
  assert.equal(r.reason, null);
});

test('fail-open — network error returns allow with registry.unavailable rule', async () => {
  let callCount = 0;
  const fetchFn = async (_url, _opts) => {
    callCount++;
    throw new Error('ENOTFOUND registry.npmjs.org');
  };
  const cache = {};
  const r = await evaluateRegistry({
    command: 'npm install some-package',
    config: CFG,
    fetchFn,
    cache,
    now: NOW,
  });
  assert.equal(r.decision, 'allow', 'must fail open on network error');
  assert.equal(r.rule, 'registry.unavailable');
  assert.ok(r.reason, 'reason should describe the failure');
  assert.ok(callCount >= 1, 'fetchFn must have been attempted');
});

test('cache hit — second call does not invoke fetchFn again', async () => {
  let callCount = 0;
  const fetchFn = async (_url, _opts) => {
    callCount++;
    return {
      ok: false, status: 404, json: async () => ({}),
    };
  };
  const cache = {};

  // First call: cache miss → fetchFn invoked.
  const r1 = await evaluateRegistry({
    command: 'npm install cached-pkg',
    config: CFG,
    fetchFn,
    cache,
    now: NOW,
  });
  assert.equal(r1.decision, 'deny');
  assert.equal(callCount, 1, 'fetchFn must be called exactly once on cache miss');

  // Second call with the same cache object and a now still within TTL.
  const r2 = await evaluateRegistry({
    command: 'npm install cached-pkg',
    config: CFG,
    fetchFn,
    cache,
    now: NOW + 1000, // 1 s later — still within 1-hour TTL
  });
  assert.equal(r2.decision, 'deny');
  assert.equal(callCount, 1, 'fetchFn must NOT be called again on cache hit');
});

test('deny wins — compound command with one allow and one not-found package', async () => {
  // Simulate: npm install lodash (allow) && npm install <missing> (deny).
  // fetchFn differentiates by URL substring.
  const fetchFn = async (url, _opts) => {
    if (url.includes('lodash')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          time: { created: new Date(NOW - 365 * 86_400_000).toISOString() },
          downloads: { weekly: 1_000_000 },
          homepage: 'https://lodash.com',
          repository: { url: 'https://github.com/lodash/lodash' },
        }),
      };
    }
    // Any other package → 404
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const cache = {};
  const r = await evaluateRegistry({
    command: 'npm install lodash && npm install slopsquat-xyz',
    config: CFG,
    fetchFn,
    cache,
    now: NOW,
  });
  assert.equal(r.decision, 'deny', 'deny must win over allow in aggregation');
  assert.equal(r.rule, 'registry.not_found');
  assert.ok(r.matched, 'matched should be the denied package name');
});

test('allow — non-install bash command returns allow silently', async () => {
  let callCount = 0;
  const fetchFn = async () => { callCount++; return {}; };
  const cache = {};

  for (const cmd of ['ls -la', 'cat file.txt', 'git status', 'echo hello']) {
    const r = await evaluateRegistry({
      command: cmd,
      config: CFG,
      fetchFn,
      cache,
      now: NOW,
    });
    assert.equal(r.decision, 'allow', `${cmd} should return allow`);
    assert.equal(r.rule, null);
    assert.equal(r.matched, null);
    assert.equal(r.matched_segment, null);
    assert.equal(r.reason, null);
  }
  assert.equal(callCount, 0, 'fetchFn must never be called for non-install commands');
});
