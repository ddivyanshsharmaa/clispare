'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
];

function getHomeDir(env = process.env) {
  if (env && env.CLISPARE_HOME && String(env.CLISPARE_HOME).trim()) {
    return path.resolve(String(env.CLISPARE_HOME).trim());
  }
  return path.join(os.homedir(), '.clispare');
}

function safeChmod(targetPath, mode) {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (_) {
    // Best-effort on Windows and restricted filesystems
  }
}

function ensureDir(dirPath, mode = 0o700) {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  safeChmod(dirPath, mode);
  return dirPath;
}

function ensureHomeDir(homeDir = getHomeDir()) {
  return ensureDir(homeDir, 0o700);
}

function atomicWriteFileSync(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  ensureDir(dir, 0o700);
  const rand = Math.random().toString(36).slice(2, 10);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${rand}.tmp`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode });
  safeChmod(tmpPath, mode);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.copyFileSync(tmpPath, filePath);
      fs.rmSync(tmpPath, { force: true });
    } catch (innerErr) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch (_) {}
      throw err;
    }
  }
  safeChmod(filePath, mode);
}

function getActiveCredentialEnvVars(env = process.env) {
  if (!env) return [];
  const active = new Set();
  const upperTargets = new Set(CREDENTIAL_ENV_VARS);
  for (const [k, v] of Object.entries(env)) {
    const upper = k.toUpperCase();
    if (upperTargets.has(upper) && v !== undefined && String(v).trim() !== '') {
      active.add(upper);
    }
  }
  return Array.from(active);
}

function cleanCredentialEnv(env = process.env, extra = {}) {
  const cleaned = {};
  const upperTargets = new Set(CREDENTIAL_ENV_VARS);
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      if (!upperTargets.has(k.toUpperCase()) && v !== undefined) {
        cleaned[k] = v;
      }
    }
  }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined || v === null) {
      delete cleaned[k];
    } else {
      cleaned[k] = String(v);
    }
  }
  return cleaned;
}

function isFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile();
  } catch (_) {
    return false;
  }
}

function isExecutableFile(filePath, platform = process.platform) {
  if (!isFile(filePath)) return false;
  if (platform === 'win32') return true;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function getPathValue(env = process.env) {
  if (!env) return '';
  if (typeof env.PATH === 'string') return env.PATH;
  if (typeof env.Path === 'string') return env.Path;
  if (typeof env.path === 'string') return env.path;
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === 'PATH' && typeof v === 'string') return v;
  }
  return '';
}

function getPathExtList(env = process.env) {
  let raw = '.COM;.EXE;.BAT;.CMD';
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      if (k.toUpperCase() === 'PATHEXT' && typeof v === 'string' && v.trim()) {
        raw = v;
        break;
      }
    }
  }
  return raw
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
}

function resolveBinary(binName, env = process.env, platform = process.platform) {
  if (!binName || typeof binName !== 'string') return null;

  // If binName contains a path separator, check directly
  if (binName.includes('/') || binName.includes('\\')) {
    if (platform === 'win32') {
      const exts = getPathExtList(env);
      const lower = binName.toLowerCase();
      if (exts.some((e) => lower.endsWith(e.toLowerCase())) && isFile(binName)) {
        return path.resolve(binName);
      }
      for (const ext of exts) {
        if (isFile(binName + ext)) return path.resolve(binName + ext);
        if (isFile(binName + ext.toLowerCase())) return path.resolve(binName + ext.toLowerCase());
      }
      if (isFile(binName)) return path.resolve(binName);
      return null;
    }
    return isExecutableFile(binName, platform) ? path.resolve(binName) : null;
  }

  const sep = platform === 'win32' ? ';' : ':';
  const pathVal = getPathValue(env);
  const dirs = pathVal
    .split(sep)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);

  if (platform === 'win32') {
    const exts = getPathExtList(env);
    const lowerBin = binName.toLowerCase();
    const hasKnownExt = exts.some((e) => lowerBin.endsWith(e.toLowerCase()));

    for (const dir of dirs) {
      if (hasKnownExt) {
        const direct = path.join(dir, binName);
        if (isFile(direct)) return direct;
      }
      for (const ext of exts) {
        const candLower = path.join(dir, binName + ext.toLowerCase());
        if (isFile(candLower)) return candLower;
        const candUpper = path.join(dir, binName + ext.toUpperCase());
        if (isFile(candUpper)) return candUpper;
      }
      const exact = path.join(dir, binName);
      if (isFile(exact)) return exact;
    }
    return null;
  }

  for (const dir of dirs) {
    const candidate = path.join(dir, binName);
    if (isExecutableFile(candidate, platform)) {
      return candidate;
    }
  }
  return null;
}

function isCmdOrBat(filePath) {
  return Boolean(filePath && /\.(cmd|bat)$/i.test(filePath));
}

function formatTime(epochMs) {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatDuration(ms) {
  if (ms <= 0) return '0s';
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (h === 0 && m === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function createLineReader(input = process.stdin, output = process.stdout) {
  const isTTY = Boolean(input && input.isTTY);
  const lineQueue = [];
  const waiters = [];
  let buffer = '';
  let ended = false;
  let rawListenerActive = false;

  function flushWaiters() {
    while (waiters.length > 0) {
      if (lineQueue.length > 0) {
        const line = lineQueue.shift();
        const resolve = waiters.shift();
        resolve(line);
      } else if (ended) {
        const resolve = waiters.shift();
        resolve(null);
      } else {
        break;
      }
    }
  }

  function onData(chunk) {
    if (rawListenerActive) return;
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      lineQueue.push(line);
    }
    flushWaiters();
  }

  function onEnd() {
    if (buffer.length > 0) {
      lineQueue.push(buffer.replace(/\r$/, ''));
      buffer = '';
    }
    ended = true;
    flushWaiters();
  }

  input.on('data', onData);
  input.on('end', onEnd);
  input.on('close', onEnd);
  input.on('error', onEnd);
  if (typeof input.resume === 'function') {
    input.resume();
  }

  function question(promptText = '') {
    if (promptText && output && typeof output.write === 'function') {
      output.write(promptText);
    }
    if (lineQueue.length > 0) {
      return Promise.resolve(lineQueue.shift());
    }
    if (ended) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  function readSecret(promptText = '') {
    if (!isTTY || typeof input.setRawMode !== 'function') {
      // Non-TTY: plain line read without echoing the line
      return question(promptText);
    }
    if (promptText && output && typeof output.write === 'function') {
      output.write(promptText);
    }
    if (lineQueue.length > 0) {
      if (output && typeof output.write === 'function') output.write('\n');
      return Promise.resolve(lineQueue.shift());
    }
    if (ended) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      rawListenerActive = true;
      let secret = '';
      try {
        input.setRawMode(true);
      } catch (_) {}

      function cleanup() {
        rawListenerActive = false;
        input.removeListener('data', onRawData);
        try {
          input.setRawMode(false);
        } catch (_) {}
      }

      function onRawData(chunk) {
        const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (let i = 0; i < str.length; i++) {
          const ch = str[i];
          if (ch === '\r' || ch === '\n') {
            cleanup();
            if (output && typeof output.write === 'function') output.write('\n');
            resolve(secret);
            return;
          }
          if (ch === '\u0003' || ch === '\u0004') {
            // Ctrl+C or Ctrl+D
            cleanup();
            if (output && typeof output.write === 'function') output.write('\n');
            resolve(null);
            return;
          }
          if (ch === '\u007f' || ch === '\b') {
            secret = secret.slice(0, -1);
          } else {
            secret += ch;
          }
        }
      }

      input.on('data', onRawData);
    });
  }

  function close() {
    input.removeListener('data', onData);
    input.removeListener('end', onEnd);
    input.removeListener('close', onEnd);
    input.removeListener('error', onEnd);
    if (typeof input.pause === 'function') {
      try {
        input.pause();
      } catch (_) {}
    }
  }

  return { question, readSecret, close, isTTY };
}

module.exports = {
  CREDENTIAL_ENV_VARS,
  getHomeDir,
  safeChmod,
  ensureDir,
  ensureHomeDir,
  atomicWriteFileSync,
  getActiveCredentialEnvVars,
  cleanCredentialEnv,
  resolveBinary,
  isCmdOrBat,
  formatTime,
  formatDuration,
  createLineReader,
};
