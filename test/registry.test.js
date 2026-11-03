'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  addAccount,
  removeAccount,
  setDefaultAccount,
  getDefaultAccount,
  listAccounts,
  readKeyFile,
  getAccountsPath,
} = require('../src/registry');
const {
  setCooldown,
  getCooldown,
  readState,
  resetCooldowns,
  getStatePath,
  getLockDir,
} = require('../src/state');

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clispare-reg-test-'));
}

test('registry add, default, duplicate rejection, and remove with/without purge', () => {
  const homeDir = makeTempHome();
  try {
    const a1 = addAccount(
      { service: 'claude', name: 'personal', id: 'me@example.com', kind: 'login' },
      homeDir
    );
    assert.equal(a1.default, true);
    assert.equal(a1.env, 'CLAUDE_CONFIG_DIR');
    assert.ok(fs.existsSync(a1.location));

    const a2 = addAccount(
      { service: 'claude', name: 'work', id: 'work@example.com', kind: 'login' },
      homeDir
    );
    assert.equal(a2.default, false);

    // Duplicate per service must be rejected
    assert.throws(
      () => addAccount({ service: 'claude', name: 'personal', kind: 'login' }, homeDir),
      /duplicate|already exists/i
    );

    // Default switching
    setDefaultAccount('claude', 'work', homeDir);
    assert.equal(getDefaultAccount('claude', homeDir).name, 'work');

    // Remove without purge leaves login profile folder intact
    const removed1 = removeAccount('claude', 'personal', { purge: false }, homeDir);
    assert.ok(fs.existsSync(removed1.location));

    // Remove with purge deletes login profile folder
    const removed2 = removeAccount('claude', 'work', { purge: true }, homeDir);
    assert.ok(!fs.existsSync(removed2.location));
    assert.equal(listAccounts(homeDir).length, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('registry rejects EOF, reserved words like "done", and path traversal names', () => {
  const homeDir = makeTempHome();
  try {
    const badNames = [
      null,
      undefined,
      '',
      '   ',
      'done',
      'DONE',
      'cancel',
      'back',
      'quit',
      'exit',
      'q',
      '../evil',
      '..\\evil',
      'foo/bar',
      'foo\\bar',
      '..',
      '.',
      '.hidden',
      'bad:name',
    ];

    for (const bad of badNames) {
      assert.throws(
        () => addAccount({ service: 'claude', name: bad, kind: 'login' }, homeDir),
        /invalid|reserved|traversal/i,
        `Expected name "${bad}" to be rejected`
      );
    }

    assert.equal(listAccounts(homeDir).length, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('apikey storage uses 0600 on POSIX and never writes key to accounts.json or state.json', () => {
  const homeDir = makeTempHome();
  const fakeSecret = 'sk-test-fake-secret-998877665544332211';
  try {
    const acc = addAccount(
      {
        service: 'deepseek',
        name: 'main',
        id: 'api@example.com',
        kind: 'apikey',
        key: fakeSecret,
      },
      homeDir
    );

    assert.equal(readKeyFile('deepseek', 'main', homeDir), fakeSecret);
    assert.ok(fs.existsSync(acc.location));

    if (process.platform !== 'win32') {
      const st = fs.statSync(acc.location);
      assert.equal(st.mode & 0o777, 0o600);
      const homeSt = fs.statSync(homeDir);
      assert.equal(homeSt.mode & 0o777, 0o700);
    }

    const rawAccountsJson = fs.readFileSync(getAccountsPath(homeDir), 'utf8');
    assert.ok(!rawAccountsJson.includes(fakeSecret), 'Key must never appear in accounts.json');

    setCooldown('deepseek', 'main', Date.now() + 60000, 'limit', homeDir);
    const rawStateJson = fs.readFileSync(getStatePath(homeDir), 'utf8');
    assert.ok(!rawStateJson.includes(fakeSecret), 'Key must never appear in state.json');

    // Removing apikey account deletes key file
    removeAccount('deepseek', 'main', {}, homeDir);
    assert.ok(!fs.existsSync(acc.location));
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('state.js prunes expired entries on read, cleans stale locks, and resets cooldowns', () => {
  const homeDir = makeTempHome();
  try {
    const now = Date.now();
    setCooldown('claude', 'main', now + 120000, 'limit', homeDir, now);
    setCooldown('codex', 'main', now + 5000, 'transient', homeDir, now);

    assert.ok(getCooldown('claude', 'main', homeDir, now));
    assert.ok(getCooldown('codex', 'main', homeDir, now));

    // Read in the future after codex cooldown expired
    const futureState = readState(homeDir, now + 10000);
    assert.ok(futureState['claude:main']);
    assert.equal(futureState['codex:main'], undefined);

    // Create an artificially stale lock dir and verify setCooldown cleans it up
    const lockDir = getLockDir(homeDir);
    fs.mkdirSync(lockDir, { recursive: true });
    const oldTime = new Date(Date.now() - 10000);
    fs.utimesSync(lockDir, oldTime, oldTime);

    setCooldown('grok', 'main', now + 60000, 'auth', homeDir, now);
    assert.ok(getCooldown('grok', 'main', homeDir, now));
    assert.ok(!fs.existsSync(lockDir));

    // Reset single service
    resetCooldowns('claude', homeDir);
    assert.equal(getCooldown('claude', 'main', homeDir, now), null);
    assert.ok(getCooldown('grok', 'main', homeDir, now));

    // Reset all
    resetCooldowns(null, homeDir);
    assert.deepEqual(readState(homeDir, now), {});
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
