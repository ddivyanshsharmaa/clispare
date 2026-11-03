'use strict';

const fs = require('node:fs');
const {
  getHomeDir,
  resolveBinary,
  formatTime,
  formatDuration,
} = require('./util');
const {
  DEFAULT_CLI_ENGINES,
  getService,
} = require('./services');
const {
  listAccounts,
  readKeyFile,
} = require('./registry');
const {
  getCooldown,
  setCooldown,
} = require('./state');
const classify = require('./classify');
const { runHeadlessCli, DEFAULT_TIMEOUT_MS } = require('./adapters/cli');
const { runHttpCompletion, DEFAULT_HTTP_TIMEOUT_MS } = require('./adapters/http');

const DEFAULT_RETRY_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildOrderedLanes({
  accounts,
  engines = null,
  lanes = [],
}) {
  // Map of service -> account name from --lane service:name (first wins per service)
  const laneOverrides = new Map();
  const explicitServiceOrder = [];

  for (const laneSpec of lanes || []) {
    const str = String(laneSpec).trim();
    const idx = str.indexOf(':');
    if (idx === -1) continue;
    const svc = str.slice(0, idx).trim().toLowerCase();
    const accName = str.slice(idx + 1).trim();
    if (!svc || !accName) continue;
    if (!laneOverrides.has(svc)) {
      laneOverrides.set(svc, accName);
      explicitServiceOrder.push(svc);
    }
  }

  // Determine service order
  const serviceOrder = [];
  const seenServices = new Set();

  function addService(s) {
    const clean = String(s).trim().toLowerCase();
    if (!clean || seenServices.has(clean)) return;
    seenServices.add(clean);
    serviceOrder.push(clean);
  }

  if (Array.isArray(engines) && engines.length > 0) {
    for (const eng of engines) {
      addService(eng);
    }
  } else {
    for (const svc of explicitServiceOrder) {
      addService(svc);
    }
    for (const svc of DEFAULT_CLI_ENGINES) {
      addService(svc);
    }
    // Then API-key services (and any other registered services) in the order added
    for (const acc of accounts) {
      addService(acc.service);
    }
  }

  // Pick at most ONE account per service
  const ordered = [];
  for (const serviceId of serviceOrder) {
    const forService = accounts.filter((a) => a.service === serviceId);
    let chosen = null;
    if (laneOverrides.has(serviceId)) {
      const targetName = laneOverrides.get(serviceId);
      chosen = forService.find((a) => a.name === targetName) || null;
      if (!chosen) {
        ordered.push({
          serviceId,
          account: null,
          missingLaneAccount: targetName,
        });
        continue;
      }
    } else if (forService.length > 0) {
      chosen = forService.find((a) => a.default) || forService[0];
    }
    ordered.push({
      serviceId,
      account: chosen,
      missingLaneAccount: null,
    });
  }

  return ordered;
}

async function executeLaneAttempt({
  service,
  account,
  prompt,
  timeoutMs,
  homeDir,
  env,
  platform,
}) {
  if (service.kind === 'apikey') {
    const httpTimeout =
      typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_HTTP_TIMEOUT_MS;
    return runHttpCompletion({
      service,
      account,
      prompt,
      homeDir,
      timeoutMs: httpTimeout,
      env,
    });
  }

  const cliTimeout =
    typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  return runHeadlessCli({
    service,
    account,
    prompt,
    timeoutMs: cliTimeout,
    env,
    platform,
  });
}

async function runWithFailover({
  prompt,
  engines = null,
  lanes = [],
  timeoutMs = null,
  json = false,
  verbose = false,
  homeDir = null,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  platform = process.platform,
  retryDelayMs = null,
}) {
  const resolvedHome = homeDir || getHomeDir(env);
  const accounts = listAccounts(resolvedHome);
  const orderedCandidates = buildOrderedLanes({ accounts, engines, lanes });

  const effectiveRetryDelay =
    typeof retryDelayMs === 'number'
      ? retryDelayMs
      : env && env.CLISPARE_RETRY_DELAY_MS !== undefined
      ? Number(env.CLISPARE_RETRY_DELAY_MS)
      : DEFAULT_RETRY_DELAY_MS;

  const coolingLanes = [];

  function logStderr(msg) {
    if (stderr && typeof stderr.write === 'function') {
      stderr.write(`${msg}\n`);
    }
  }

  function logVerbose(msg) {
    if (verbose) {
      logStderr(msg);
    }
  }

  for (const candidate of orderedCandidates) {
    const { serviceId, account, missingLaneAccount } = candidate;

    if (missingLaneAccount) {
      logVerbose(`[clispare] ${serviceId}:${missingLaneAccount}: skipped (account not found)`);
      continue;
    }

    if (!account) {
      logVerbose(`[clispare] ${serviceId}: skipped (not signed in / no account registered)`);
      continue;
    }

    const svc = getService(serviceId, account);
    if (!svc) {
      logVerbose(`[clispare] ${serviceId}:${account.name}: skipped (unknown service)`);
      continue;
    }

    // Check headless adapter support first for firstrun tools
    if ((svc.kind === 'firstrun' || svc.kind === 'login') && !svc.headless) {
      // Spec: Only agy gets a headless adapter in v0.1; for the others run skips them with a clear message.
      logStderr(`[clispare] ${serviceId}: skipped (no headless adapter in v0.1)`);
      continue;
    }

    // Check cooldown in state.json
    const now = Date.now();
    const activeCooldown = getCooldown(serviceId, account.name, resolvedHome, now);
    if (activeCooldown && activeCooldown.until > now) {
      if (activeCooldown.reason === 'limit' || activeCooldown.reason === 'transient') {
        coolingLanes.push({
          service: serviceId,
          name: account.name,
          until: activeCooldown.until,
          reason: activeCooldown.reason,
        });
      }
      logVerbose(
        `[clispare] ${serviceId}:${account.name}: skipped (cooling down: ${activeCooldown.reason} until ${formatTime(activeCooldown.until)})`
      );
      continue;
    }

    // Check installation / key / sign-in readiness
    if (svc.kind === 'login' || svc.kind === 'firstrun') {
      const binPath = resolveBinary(svc.bin, env, platform);
      if (!binPath) {
        logVerbose(`[clispare] ${serviceId}:${account.name}: skipped (${svc.bin} not installed)`);
        continue;
      }
      if (svc.kind === 'login') {
        if (!account.location || !fs.existsSync(account.location)) {
          logVerbose(`[clispare] ${serviceId}:${account.name}: skipped (profile folder missing)`);
          continue;
        }
      }
    } else if (svc.kind === 'apikey') {
      const key = readKeyFile(serviceId, account.name, resolvedHome);
      if (!key) {
        logVerbose(`[clispare] ${serviceId}:${account.name}: skipped (without a key)`);
        continue;
      }
    }

    logVerbose(`[clispare] ${serviceId}:${account.name}: trying...`);

    let attempt = await executeLaneAttempt({
      service: svc,
      account,
      prompt,
      timeoutMs,
      homeDir: resolvedHome,
      env,
      platform,
    });

    let attemptNow = Date.now();
    let resultClass = classify(attempt, attemptNow);

    // Transient: retry the same lane ONCE after 2 s, then go to the next lane with a 5-minute cooldown
    if (resultClass.category === 'transient') {
      logStderr(`[clispare] ${serviceId}: transient error, retrying once in 2s...`);
      if (effectiveRetryDelay > 0) {
        await sleep(effectiveRetryDelay);
      }
      attempt = await executeLaneAttempt({
        service: svc,
        account,
        prompt,
        timeoutMs,
        homeDir: resolvedHome,
        env,
        platform,
      });
      attemptNow = Date.now();
      resultClass = classify(attempt, attemptNow);

      if (resultClass.category === 'transient') {
        const until = attemptNow + 5 * 60 * 1000;
        setCooldown(serviceId, account.name, until, 'transient', resolvedHome, attemptNow);
        coolingLanes.push({
          service: serviceId,
          name: account.name,
          until,
          reason: 'transient',
        });
        logStderr(
          `[clispare] ${serviceId}: transient error persisted, cooling down until ${formatTime(until)}`
        );
        continue;
      }
    }

    if (resultClass.category === 'ok') {
      const answer = attempt.output ?? attempt.stdout ?? '';
      if (json) {
        stdout.write(
          JSON.stringify({
            ok: true,
            service: serviceId,
            account: account.name,
            output: answer,
          }) + '\n'
        );
      } else {
        stdout.write(answer);
      }
      return {
        exitCode: 0,
        service: serviceId,
        account: account.name,
        output: answer,
      };
    }

    if (resultClass.category === 'limit') {
      const until = attemptNow + resultClass.cooldownMs;
      setCooldown(serviceId, account.name, until, 'limit', resolvedHome, attemptNow);
      coolingLanes.push({
        service: serviceId,
        name: account.name,
        until,
        reason: 'limit',
      });
      logStderr(`[clispare] ${serviceId}: usage limit, cooling down until ${formatTime(until)}`);
      continue;
    }

    if (resultClass.category === 'auth') {
      const until = attemptNow + 10 * 60 * 1000;
      setCooldown(serviceId, account.name, until, 'auth', resolvedHome, attemptNow);
      logStderr(`[clispare] ${serviceId}: needs sign-in, cooling down until ${formatTime(until)}`);
      continue;
    }

    // Fatal: STOP and return that error. Never fail over on a task failure.
    const fatalMsg = (attempt.stderr || attempt.stdout || 'Fatal task error').trim();
    if (json) {
      stdout.write(
        JSON.stringify({
          ok: false,
          error: fatalMsg,
          service: serviceId,
          account: account.name,
        }) + '\n'
      );
    }
    logStderr(fatalMsg);
    return {
      exitCode: 1,
      error: fatalMsg,
      service: serviceId,
      account: account.name,
    };
  }

  // All candidates exhausted
  if (coolingLanes.length > 0) {
    const earliest = Math.min(...coolingLanes.map((c) => c.until));
    const remainingMs = Math.max(0, earliest - Date.now());
    const resetMsg = `[clispare] All lanes are cooling down or limited. Earliest reset: ${formatTime(earliest)} (in ${formatDuration(remainingMs)})`;
    logStderr(resetMsg);
    if (json) {
      stdout.write(
        JSON.stringify({
          ok: false,
          exitCode: 75,
          earliestReset: earliest,
          earliestResetFormatted: formatTime(earliest),
        }) + '\n'
      );
    }
    return {
      exitCode: 75,
      earliestReset: earliest,
    };
  }

  const noLaneMsg = '[clispare] Nothing is signed in or no usable lane available.';
  logStderr(noLaneMsg);
  if (json) {
    stdout.write(
      JSON.stringify({
        ok: false,
        exitCode: 77,
        error: noLaneMsg,
      }) + '\n'
    );
  }
  return {
    exitCode: 77,
  };
}

module.exports = {
  DEFAULT_RETRY_DELAY_MS,
  buildOrderedLanes,
  runWithFailover,
};
