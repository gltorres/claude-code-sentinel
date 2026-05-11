// registry policy — Sprint 05.
import { walk } from './bash-walker.mjs';
import { parseInstallSegments } from './install-commands.mjs';
import { fetchPackageMetadata } from './registry-clients.mjs';
import { getCached, setCached } from './registry-cache.mjs';

// Returns Promise<{ decision: 'allow'|'ask'|'deny',
//                   rule: string|null,
//                   matched: string|null,
//                   matched_segment: string|null,
//                   reason: string|null }>
export async function evaluateRegistry({ command, config, fetchFn, cache, now }) {
  const regCfg = (config && config.registry) || {};
  const ecoCfg = (config && config.ecosystems) || {};
  const ttlMs = (regCfg.cacheTtlHours ?? 1) * 3_600_000;
  const timeoutMs = regCfg.timeoutMs ?? 250;

  const walked = walk(command);
  if (walked.exotic) return { decision: 'allow', rule: null, matched: null, matched_segment: null, reason: null };

  const installs = parseInstallSegments(walked, { ecosystems: ecoCfg });
  if (installs.length === 0) return { decision: 'allow', rule: null, matched: null, matched_segment: null, reason: null };

  const results = await Promise.all(installs.map(async install => {
    const key = `${install.ecosystem}:${install.name.toLowerCase()}`;
    const hit = getCached(cache, key, ttlMs, now);
    if (hit) return { ...hit, install };

    const fetched = await fetchPackageMetadata({
      ecosystem: install.ecosystem, name: install.name, fetchFn, timeoutMs,
    });
    const decided = decideFromFetch(fetched, install, regCfg);
    setCached(cache, key, decided, now);
    return { ...decided, install };
  }));

  return aggregate(results);
}

// 5-step decision tree:
//   404 (not_found)                       → deny  (rule 'registry.not_found')
//   ageDays < minAgeDays                  → ask   (rule 'registry.too_new')
//   weeklyDownloads != null && weeklyDownloads < minWeeklyDownloads → ask (rule 'registry.low_downloads')
//   requireHomepage && !hasHomepage && !hasRepository → ask (rule 'registry.no_source')
//   else                                  → allow (rule null)
function decideFromFetch(fetched, install, regCfg) {
  if (fetched.status === 'error') {
    return { decision: 'allow', rule: 'registry.unavailable', reason: `Registry lookup failed for ${install.name}` };
  }
  if (fetched.status === 'not_found') {
    return { decision: 'deny', rule: 'registry.not_found', reason: `Package ${install.name} not found in ${install.ecosystem} registry` };
  }
  const meta = fetched.meta;
  const minAge = regCfg.minAgeDays ?? 14;
  const minDl  = regCfg.minWeeklyDownloads ?? 100;
  const reqHp  = regCfg.requireHomepage !== false;
  if (meta.ageDays < minAge) {
    return { decision: 'ask', rule: 'registry.too_new', reason: `Package ${install.name} is only ${meta.ageDays} days old (< ${minAge})` };
  }
  if (meta.weeklyDownloads != null && meta.weeklyDownloads < minDl) {
    return { decision: 'ask', rule: 'registry.low_downloads', reason: `Package ${install.name} has only ${meta.weeklyDownloads} weekly downloads (< ${minDl})` };
  }
  if (reqHp && !meta.hasHomepage && !meta.hasRepository) {
    return { decision: 'ask', rule: 'registry.no_source', reason: `Package ${install.name} has no homepage or repository` };
  }
  return { decision: 'allow', rule: null, reason: null };
}

// Aggregate priority: deny > ask > allow.
// Among results sharing the strongest decision, pick the first.
// 'registry.unavailable' is allow-with-reason — only surfaces if NO stronger decision exists.
function aggregate(results) {
  const order = { deny: 3, ask: 2, allow: 1 };
  let best = results[0];
  for (const r of results) {
    if (order[r.decision] > order[best.decision]) best = r;
  }
  return {
    decision: best.decision,
    rule: best.rule,
    matched: best.install?.name ?? null,
    matched_segment: best.install?.segment?.raw ?? null,
    reason: best.reason,
  };
}
