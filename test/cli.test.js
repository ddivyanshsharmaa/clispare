'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { runCli } = require('../src/cli');
const { addAccount } = require('../src/registry');
const { setCooldown } = require('../src/state');

function runCmd(argv, options = {}) {
  let stdout = '';
  let stderr = '';
  const stdin = options.stdin || new PassThrough();
  if (!options.stdin) stdin.end();

  return runCli(argv, {
    ...options,
    stdin,
    stdout: { write: (s) => { stdout += String(s); } },
    stderr: { write: (s) => { stderr += String(s); } },
  }).then((code) => ({ code, stdout, stderr }));
}

test('list and status never print keys and format commands by platform', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clispare-cli-list-'));
  const secretKey = 'sk-never-print-this-key-value-99999';

  try {
    addAccount(
      { service: 'claude', name: 'work', id: 'work@example.com', kind: 'login' },
      homeDir
    );
    addAccount(
      { service: 'deepseek', name: 'main', id: 'ds@example.com', kind: 'apikey', key: secretKey },
      homeDir
    );
    addAccount(
      { service: 'agy', name: 'main', id: 'agy@example.com', kind: 'firstrun' },
      homeDir
    );

    setCooldown('deepseek', 'main', Date.now() + 300000, 'limit', homeDir);

    // Win32 list
    const listWin = await runCmd(['list'], { homeDir, platform: 'win32' });
    assert.equal(listWin.code, 0);
    assert.match(listWin.stdout, /\$env:CLAUDE_CONFIG_DIR=/);
    assert.match(listWin.stdout, /\$env:DEEPSEEK_API_KEY=\(Get-Content -Raw/);
    assert.ok(!listWin.stdout.includes(secretKey), 'list must never print key');

    // POSIX list
    const listPosix = await runCmd(['list'], { homeDir, platform: 'linux' });
    assert.equal(listPosix.code, 0);
    assert.match(listPosix.stdout, /CLAUDE_CONFIG_DIR=/);
    assert.match(listPosix.stdout, /export DEEPSEEK_API_KEY=/);
    assert.ok(!listPosix.stdout.includes(secretKey), 'list must never print key');

    // JSON list
    const listJson = await runCmd(['list', '--json'], { homeDir, platform: 'linux' });
    assert.equal(listJson.code, 0);
    assert.ok(!listJson.stdout.includes(secretKey));
    const parsedList = JSON.parse(listJson.stdout);
    assert.equal(parsedList.length, 3);

    // Status text & JSON
    const statusText = await runCmd(['status'], { homeDir });
    assert.equal(statusText.code, 0);
    assert.match(statusText.stdout, /not verified/);
    assert.match(statusText.stdout, /key present/);
    assert.match(statusText.stdout, /limit/);
    assert.ok(!statusText.stdout.includes(secretKey), 'status must never print key');

    const statusJson = await runCmd(['status', '--json'], { homeDir });
    assert.equal(statusJson.code, 0);
    assert.ok(!statusJson.stdout.includes(secretKey), 'status --json must never print key');
    const parsedStatus = JSON.parse(statusJson.stdout);
    assert.equal(parsedStatus.accounts.length, 3);

    // use for apikey prints export line without key
    const useWin = await runCmd(['use', 'deepseek:main'], { homeDir, platform: 'win32' });
    assert.equal(useWin.code, 0);
    assert.match(useWin.stdout, /\$env:DEEPSEEK_API_KEY=/);
    assert.ok(!useWin.stdout.includes(secretKey));

    const usePosix = await runCmd(['use', 'deepseek'], { homeDir, platform: 'linux' });
    assert.equal(usePosix.code, 0);
    assert.match(usePosix.stdout, /export DEEPSEEK_API_KEY=/);
    assert.ok(!usePosix.stdout.includes(secretKey));
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('CLI commands: default, remove, reset, doctor, help, version, and exit codes', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clispare-cli-cmds-'));

  try {
    // --version and --help
    const ver = await runCmd(['--version'], { homeDir });
    assert.equal(ver.code, 0);
    assert.equal(ver.stdout.trim(), require('../package.json').version);

    const help = await runCmd(['--help'], { homeDir });
    assert.equal(help.code, 0);
    for (const cmd of ['add', 'list', 'remove', 'default', 'status', 'use', 'run', 'reset', 'doctor', 'help']) {
      assert.match(help.stdout, new RegExp(`\\b${cmd}\\b`));
      const subHelp = await runCmd(['help', cmd], { homeDir });
      assert.equal(subHelp.code, 0);
    }

    // doctor
    const doc = await runCmd(['doctor'], {
      homeDir,
      env: { ...process.env, CLISPARE_HOME: homeDir, OPENAI_API_KEY: 'sk-test-warn' },
    });
    assert.equal(doc.code, 0);
    assert.match(doc.stdout, /Node\.js version:/);
    assert.match(doc.stdout, /OPENAI_API_KEY/);

    // default & remove commands
    const a1 = addAccount({ service: 'claude', name: 'one', kind: 'login' }, homeDir);
    const a2 = addAccount({ service: 'claude', name: 'two', kind: 'login' }, homeDir);

    const defRes = await runCmd(['default', 'claude', 'two'], { homeDir });
    assert.equal(defRes.code, 0);

    // remove without --purge prints profile folder and keeps it
    const rem1 = await runCmd(['remove', 'claude', 'one'], { homeDir });
    assert.equal(rem1.code, 0);
    assert.ok(rem1.stdout.includes(a1.location));
    assert.equal(fs.existsSync(a1.location), true);

    // remove with --purge deletes profile folder
    const rem2 = await runCmd(['remove', 'claude', 'two', '--purge'], { homeDir });
    assert.equal(rem2.code, 0);
    assert.equal(fs.existsSync(a2.location), false);

    // Bad usage exit codes (2)
    assert.equal((await runCmd(['unknown-cmd'], { homeDir })).code, 2);
    assert.equal((await runCmd(['help', 'nonexistent'], { homeDir })).code, 2);
    assert.equal((await runCmd(['remove'], { homeDir })).code, 2);
    assert.equal((await runCmd(['default', 'only-one-arg'], { homeDir })).code, 2);
    assert.equal((await runCmd(['run', '--timeout', 'invalid', 'hi'], { homeDir })).code, 2);
    assert.equal((await runCmd(['run', '--lane', 'missingcolon', 'hi'], { homeDir })).code, 2);
    assert.equal((await runCmd(['run'], { homeDir })).code, 2);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
