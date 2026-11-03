'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  getHomeDir,
  ensureHomeDir,
  ensureDir,
  atomicWriteFileSync,
} = require('./util');
const { getService } = require('./services');

const RESERVED_NAMES = new Set([
  'done',
  'cancel',
  'back',
  'quit',
  'exit',
  'q',
]);

function isCancelWord(val) {
  if (val === null || val === undefined) return true;
  const lower = String(val).trim().toLowerCase();
  return RESERVED_NAMES.has(lower);
}

function sanitizeName(rawName, label = 'name') {
  if (rawName === null || rawName === undefined) {
    throw new Error(`Invalid ${label}: empty or end of input`);
  }
  const str = String(rawName).trim();
  if (!str) {
    throw new Error(`Invalid ${label}: cannot be empty`);
  }
  if (
    str.includes('..') ||
    str.includes('/') ||
    str.includes('\\') ||
    str.includes('\0') ||
    str.includes(':') ||
    str.startsWith('.')
  ) {
    throw new Error(`Invalid ${label}: path traversal or illegal characters`);
  }
  if (RESERVED_NAMES.has(str.toLowerCase())) {
    throw new Error(`Invalid ${label}: "${str}" is reserved`);
  }
  const sanitised = str.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!sanitised || !/^[A-Za-z0-9_-]+$/.test(sanitised)) {
    throw new Error(`Invalid ${label}: must contain [A-Za-z0-9_-]`);
  }
  if (RESERVED_NAMES.has(sanitised.toLowerCase())) {
    throw new Error(`Invalid ${label}: "${sanitised}" is reserved`);
  }
  return sanitised;
}

function getAccountsPath(homeDir = getHomeDir()) {
  return path.join(homeDir, 'accounts.json');
}

function getProfileDir(service, name, homeDir = getHomeDir()) {
  const s = sanitizeName(service, 'service').toLowerCase();
  const n = sanitizeName(name, 'account name');
  const base = path.resolve(homeDir, 'profiles');
  const full = path.resolve(base, s, n);
  if (!full.startsWith(base + path.sep)) {
    throw new Error('Invalid profile path: path traversal detected');
  }
  return full;
}

function getKeyPath(service, name, homeDir = getHomeDir()) {
  const s = sanitizeName(service, 'service').toLowerCase();
  const n = sanitizeName(name, 'account name');
  const base = path.resolve(homeDir, 'keys');
  const full = path.resolve(base, `${s}-${n}.key`);
  if (!full.startsWith(base + path.sep)) {
    throw new Error('Invalid key path: path traversal detected');
  }
  return full;
}

function readRegistry(homeDir = getHomeDir()) {
  const filePath = getAccountsPath(homeDir);
  if (!fs.existsSync(filePath)) {
    return { version: 1, accounts: [] };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.accounts)) {
      return { version: 1, accounts: [] };
    }
    return {
      version: 1,
      accounts: parsed.accounts,
    };
  } catch (_) {
    return { version: 1, accounts: [] };
  }
}

function writeRegistry(registryData, homeDir = getHomeDir()) {
  ensureHomeDir(homeDir);
  const accounts = (registryData.accounts || []).map((acc) => {
    const clean = {
      service: acc.service,
      name: acc.name,
      id: acc.id || '',
      kind: acc.kind,
      location: acc.location || '',
      env: acc.env || '',
      default: Boolean(acc.default),
      added: acc.added || new Date().toISOString(),
    };
    if (acc.endpoint) clean.endpoint = acc.endpoint;
    if (acc.model) clean.model = acc.model;
    return clean;
  });
  const payload = JSON.stringify({ version: 1, accounts }, null, 2) + '\n';
  atomicWriteFileSync(getAccountsPath(homeDir), payload, 0o600);
}

function writeKeyFile(service, name, key, homeDir = getHomeDir()) {
  if (!key || typeof key !== 'string' || !key.trim()) {
    throw new Error('API key cannot be empty');
  }
  ensureHomeDir(homeDir);
  const keysDir = path.join(homeDir, 'keys');
  ensureDir(keysDir, 0o700);
  const keyPath = getKeyPath(service, name, homeDir);
  atomicWriteFileSync(keyPath, key.trim() + '\n', 0o600);
  return keyPath;
}

function readKeyFile(service, name, homeDir = getHomeDir()) {
  try {
    const keyPath = getKeyPath(service, name, homeDir);
    if (!fs.existsSync(keyPath)) return null;
    const val = fs.readFileSync(keyPath, 'utf8').trim();
    return val.length > 0 ? val : null;
  } catch (_) {
    return null;
  }
}

function listAccounts(homeDir = getHomeDir(), serviceFilter = null) {
  const reg = readRegistry(homeDir);
  if (!serviceFilter) return reg.accounts;
  const s = String(serviceFilter).trim().toLowerCase();
  return reg.accounts.filter((a) => a.service === s);
}

function getAccount(service, name, homeDir = getHomeDir()) {
  const s = String(service).trim().toLowerCase();
  const n = String(name).trim();
  const reg = readRegistry(homeDir);
  return reg.accounts.find((a) => a.service === s && a.name === n) || null;
}

function getDefaultAccount(service, homeDir = getHomeDir()) {
  const accounts = listAccounts(homeDir, service);
  if (accounts.length === 0) return null;
  return accounts.find((a) => a.default) || accounts[0];
}

function addAccount(entry, homeDir = getHomeDir()) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Invalid account entry');
  }
  ensureHomeDir(homeDir);
  const service = sanitizeName(entry.service, 'service').toLowerCase();
  const name = sanitizeName(entry.name, 'account name');

  const reg = readRegistry(homeDir);
  if (reg.accounts.some((a) => a.service === service && a.name === name)) {
    throw new Error(`Duplicate account: "${name}" already exists for service "${service}"`);
  }

  const svc = getService(service, entry);
  const kind = entry.kind || (svc ? svc.kind : 'apikey');

  let location = '';
  let envName = '';

  if (kind === 'login') {
    location = entry.location || getProfileDir(service, name, homeDir);
    ensureDir(location, 0o700);
    envName = entry.env || (svc && svc.envDir) || '';
  } else if (kind === 'apikey') {
    location = getKeyPath(service, name, homeDir);
    envName =
      entry.env ||
      (svc && svc.env) ||
      `${service.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
    const secretKey = entry.key || entry.apiKey;
    if (secretKey !== undefined) {
      writeKeyFile(service, name, secretKey, homeDir);
    }
  } else if (kind === 'firstrun') {
    location = entry.location || '';
    envName = entry.env || '';
  } else {
    throw new Error(`Unknown service kind: "${kind}"`);
  }

  const existingForService = reg.accounts.filter((a) => a.service === service);
  const isDefault = existingForService.length === 0 ? true : Boolean(entry.default);
  if (isDefault) {
    for (const acc of existingForService) {
      acc.default = false;
    }
  }

  const record = {
    service,
    name,
    id: entry.id ? String(entry.id).trim() : '',
    kind,
    location,
    env: envName,
    default: isDefault,
    added: entry.added || new Date().toISOString(),
  };
  if (entry.endpoint) record.endpoint = String(entry.endpoint).trim();
  if (entry.model) record.model = String(entry.model).trim();

  reg.accounts.push(record);
  writeRegistry(reg, homeDir);
  return record;
}

function removeAccount(service, name, options = {}, homeDir = getHomeDir()) {
  if (typeof options === 'string') {
    homeDir = options;
    options = {};
  }
  const s = sanitizeName(service, 'service').toLowerCase();
  const n = sanitizeName(name, 'account name');

  const reg = readRegistry(homeDir);
  const idx = reg.accounts.findIndex((a) => a.service === s && a.name === n);
  if (idx === -1) {
    throw new Error(`Account "${s}:${n}" not found`);
  }

  const [removed] = reg.accounts.splice(idx, 1);

  if (removed.default) {
    const nextForService = reg.accounts.find((a) => a.service === s);
    if (nextForService) {
      nextForService.default = true;
    }
  }

  writeRegistry(reg, homeDir);

  // Delete key file if present
  try {
    const keyPath = getKeyPath(s, n, homeDir);
    if (fs.existsSync(keyPath)) {
      fs.rmSync(keyPath, { force: true });
    }
    if (removed.kind === 'apikey' && removed.location && fs.existsSync(removed.location)) {
      fs.rmSync(removed.location, { force: true });
    }
  } catch (_) {}

  // Purge login profile dir only if --purge is set
  if (removed.kind === 'login' && options && options.purge && removed.location) {
    const resolvedHome = path.resolve(homeDir);
    const resolvedLoc = path.resolve(removed.location);
    if (resolvedLoc.startsWith(resolvedHome + path.sep) && fs.existsSync(resolvedLoc)) {
      fs.rmSync(resolvedLoc, { recursive: true, force: true });
    }
  }

  return removed;
}

function setDefaultAccount(service, name, homeDir = getHomeDir()) {
  const s = sanitizeName(service, 'service').toLowerCase();
  const n = sanitizeName(name, 'account name');

  const reg = readRegistry(homeDir);
  const target = reg.accounts.find((a) => a.service === s && a.name === n);
  if (!target) {
    throw new Error(`Account "${s}:${n}" not found`);
  }

  for (const acc of reg.accounts) {
    if (acc.service === s) {
      acc.default = acc.name === n;
    }
  }

  writeRegistry(reg, homeDir);
  return target;
}

module.exports = {
  RESERVED_NAMES,
  isCancelWord,
  sanitizeName,
  getAccountsPath,
  getProfileDir,
  getKeyPath,
  readRegistry,
  writeRegistry,
  writeKeyFile,
  readKeyFile,
  listAccounts,
  getAccount,
  getDefaultAccount,
  addAccount,
  removeAccount,
  setDefaultAccount,
  setDefault: setDefaultAccount,
};
