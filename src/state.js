'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  getHomeDir,
  ensureHomeDir,
  atomicWriteFileSync,
} = require('./util');

const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 5000;
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  try {
    Atomics.wait(sleepBuf, 0, 0, ms);
  } catch (_) {}
}

function getStatePath(homeDir = getHomeDir()) {
  return path.join(homeDir, 'state.json');
}

function getLockDir(homeDir = getHomeDir()) {
  return path.join(homeDir, 'state.lock');
}

function acquireLock(homeDir = getHomeDir(), timeoutMs = LOCK_TIMEOUT_MS, staleMs = STALE_LOCK_MS) {
  ensureHomeDir(homeDir);
  const lockDir = getLockDir(homeDir);
  const start = Date.now();

  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      return function releaseLock() {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch (_) {}
      };
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        try {
          const st = fs.statSync(lockDir);
          if (Date.now() - st.mtimeMs >= staleMs) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch (_) {
          // Lock was removed concurrently; retry immediately
          continue;
        }
        if (Date.now() - start >= timeoutMs) {
          throw new Error('Timed out acquiring state lock');
        }
        sleepSync(15);
        continue;
      }
      throw err;
    }
  }
}

function withStateLock(homeDir, fn, timeoutMs = LOCK_TIMEOUT_MS) {
  const release = acquireLock(homeDir, timeoutMs);
  try {
    return fn();
  } finally {
    release();
  }
}

function readRawState(homeDir = getHomeDir()) {
  const filePath = getStatePath(homeDir);
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (_) {
    return {};
  }
}

function pruneStateObject(rawState, now = Date.now()) {
  const pruned = {};
  let changed = false;
  for (const [key, val] of Object.entries(rawState || {})) {
    if (
      val &&
      typeof val === 'object' &&
      typeof val.until === 'number' &&
      val.until > now &&
      typeof val.reason === 'string'
    ) {
      pruned[key] = {
        until: val.until,
        reason: val.reason,
      };
    } else {
      changed = true;
    }
  }
  return { pruned, changed };
}

function readState(homeDir = getHomeDir(), now = Date.now()) {
  const raw = readRawState(homeDir);
  const { pruned, changed } = pruneStateObject(raw, now);
  if (changed && fs.existsSync(getStatePath(homeDir))) {
    try {
      withStateLock(homeDir, () => {
        const latest = readRawState(homeDir);
        const res = pruneStateObject(latest, now);
        atomicWriteFileSync(
          getStatePath(homeDir),
          JSON.stringify(res.pruned, null, 2) + '\n',
          0o600
        );
      });
    } catch (_) {}
  }
  return pruned;
}

function setCooldown(service, name, until, reason = 'limit', homeDir = getHomeDir(), now = Date.now()) {
  let laneKey;
  if (String(service).includes(':') && (typeof until === 'string' || until === undefined)) {
    // Called as setCooldown('claude:work', untilMs, reason, homeDir)
    laneKey = String(service).trim();
    now = typeof homeDir === 'number' ? homeDir : Date.now();
    homeDir = typeof reason === 'string' && reason !== 'limit' && reason !== 'auth' && reason !== 'transient' ? reason : getHomeDir();
    reason = typeof until === 'string' ? until : 'limit';
    until = Number(name);
  } else {
    laneKey = `${String(service).trim().toLowerCase()}:${String(name).trim()}`;
  }

  const validReason = ['limit', 'auth', 'transient'].includes(reason) ? reason : 'limit';
  const entry = {
    until: Number(until),
    reason: validReason,
  };

  withStateLock(homeDir, () => {
    const raw = readRawState(homeDir);
    const { pruned } = pruneStateObject(raw, now);
    if (entry.until > now) {
      pruned[laneKey] = entry;
    } else {
      delete pruned[laneKey];
    }
    atomicWriteFileSync(getStatePath(homeDir), JSON.stringify(pruned, null, 2) + '\n', 0o600);
  });

  return entry;
}

function getCooldown(service, name, homeDir = getHomeDir(), now = Date.now()) {
  let laneKey;
  if (String(service).includes(':') && (name === undefined || typeof name === 'string')) {
    laneKey = String(service).trim();
    if (typeof name === 'string') homeDir = name;
    if (typeof homeDir === 'number') {
      now = homeDir;
      homeDir = getHomeDir();
    }
  } else {
    laneKey = `${String(service).trim().toLowerCase()}:${String(name).trim()}`;
  }

  const state = readState(homeDir, now);
  return state[laneKey] || null;
}

function resetCooldowns(target = null, homeDir = getHomeDir()) {
  return withStateLock(homeDir, () => {
    if (!target || !String(target).trim()) {
      atomicWriteFileSync(getStatePath(homeDir), '{}\n', 0o600);
      return;
    }
    const raw = readRawState(homeDir);
    const { pruned } = pruneStateObject(raw, Date.now());
    const t = String(target).trim();
    if (t.includes(':')) {
      const [s, n] = t.split(':');
      const key = `${s.toLowerCase()}:${n}`;
      delete pruned[key];
      delete pruned[t];
    } else {
      const prefix = `${t.toLowerCase()}:`;
      for (const k of Object.keys(pruned)) {
        if (k.toLowerCase().startsWith(prefix)) {
          delete pruned[k];
        }
      }
    }
    atomicWriteFileSync(getStatePath(homeDir), JSON.stringify(pruned, null, 2) + '\n', 0o600);
  });
}

module.exports = {
  LOCK_TIMEOUT_MS,
  STALE_LOCK_MS,
  getStatePath,
  getLockDir,
  acquireLock,
  withStateLock,
  readState,
  setCooldown,
  getCooldown,
  resetCooldowns,
};
