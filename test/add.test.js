'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { runCli } = require('../src/cli');
const {
  listAccounts,
  readKeyFile,
  getAccountsPath,
  getProfileDir,
} = require('../src/registry');

function createFakeBinDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clispare-fakebin-'));
  return {
    dir,
    writeCli(name, jsBody) {
      const scriptPath = path.join(dir, `${name}.js`);
      fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n'use strict';\n${jsBody}\n`, 'utf8');
      if (process.platform === 'win32') {
        const cmdPath = path.join(dir, `${name}.cmd`);
        fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
      } else {
        const shPath = path.join(dir, name);
        fs.writeFileSync(shPath, `#!/usr/bin/env node\n'use strict';\n${jsBody}\n`, 'utf8');
        fs.chmodSync(shPath, 0o755);
      }
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeEnvWithBin(binDir, homeDir, extra = {}) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const origPath = process.env.PATH || process.env.Path || '';
  return {
    ...process.env,
    PATH: `${binDir}${sep}${origPath}`,
    Path: `${binDir}${sep}${origPath}`,
    CLISPARE_HOME: homeDir,
    ...extra,
  };
}

function runScriptedAdd(lines, env, homeDir, args = ['add']) {
  const stdin = new PassThrough();
  let stdoutText = '';
  let stderrText = '';
  const stdout = {
    write(chunk) {
      stdoutText += String(chunk);
    },
  };
  const stderr = {
    write(chunk) {
      stderrText += String(chunk);
    },
  };

  const payload = lines.join('\n');
  stdin.end(payload);

  return runCli(args, {
    env,
    homeDir,
    stdin,
    stdout,
    stderr,
  }).then((code) => ({
    code,
    stdout: stdoutText,
    stderr: stderrText,
  }));
}

test('add scripted via stdin pipe: login (claude, codex, grok), credential env removal, and warning', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clispare-add-login-'));
  const fakeBin = createFakeBinDir();
  const logFile = path.join(homeDir, 'cli-invocations.json');
  fs.writeFileSync(logFile, '[]', 'utf8');

  try {
    // Fake claude records args and env to logFile, and exits 0 on auth login & auth status
    fakeBin.writeCli(
      'claude',
      `
      const fs = require('node:fs');
      const logPath = ${JSON.stringify(logFile)};
      const list = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      list.push({
        bin: 'claude',
        args: process.argv.slice(2),
        configDir: process.env.CLAUDE_CONFIG_DIR || null,
        hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
        hasOpenaiKey: Boolean(process.env.OPENAI_API_KEY),
      });
      fs.writeFileSync(logPath, JSON.stringify(list, null, 2));
      process.exit(0);
      `
    );

    // Fake codex supports login --device-auth and login status -> "Logged in as me@example.com"
    fakeBin.writeCli(
      'codex',
      `
      const fs = require('node:fs');
      const logPath = ${JSON.stringify(logFile)};
      const list = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      const args = process.argv.slice(2);
      list.push({
        bin: 'codex',
        args,
        codexHome: process.env.CODEX_HOME || null,
      });
      fs.writeFileSync(logPath, JSON.stringify(list, null, 2));
      if (args[0] === 'login' && args[1] === 'status') {
        process.stdout.write('Logged in to Codex CLI\\n');
      }
      process.exit(0);
      `
    );

    // Fake grok writes auth.json into GROK_HOME on login
    fakeBin.writeCli(
      'grok',
      `
      const fs = require('node:fs');
      const path = require('node:path');
      const args = process.argv.slice(2);
      if (args[0] === 'login' && process.env.GROK_HOME) {
        fs.mkdirSync(process.env.GROK_HOME, { recursive: true });
        fs.writeFileSync(path.join(process.env.GROK_HOME, 'auth.json'), '{"authenticated":true}\\n');
      }
      process.exit(0);
      `
    );

    const env = makeEnvWithBin(fakeBin.dir, homeDir, {
      ANTHROPIC_API_KEY: 'sk-should-be-stripped',
      OPENAI_API_KEY: 'sk-openai-should-be-stripped',
    });

    const scripted = [
      '1',                  // 1) claude
      'personal',           // account name
      'me@example.com',     // email -> triggers --email me@example.com
      '2',                  // 2) codex
      'work',               // account name
      'dev@example.com',    // id
      'y',                  // remote or headless machine? -> --device-auth
      'grok',               // 3) grok by name
      'main',               // account name
      'grok@example.com',   // id
      'n',                  // remote or headless machine? -> no
      'done',               // finish loop
      '',
    ];

    const res = await runScriptedAdd(scripted, env, homeDir);
    assert.equal(res.code, 0);

    // Check credential warning printed once at the start
    const warnMatches = res.stdout.match(/Warning: Credential env var/g) || [];
    assert.equal(warnMatches.length, 1);

    const accounts = listAccounts(homeDir);
    assert.equal(accounts.length, 3);
    assert.equal(accounts[0].service, 'claude');
    assert.equal(accounts[0].name, 'personal');
    assert.equal(accounts[0].id, 'me@example.com');

    assert.equal(accounts[1].service, 'codex');
    assert.equal(accounts[1].name, 'work');

    assert.equal(accounts[2].service, 'grok');
    assert.equal(accounts[2].name, 'main');

    const invocations = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    const claudeLogin = invocations.find((i) => i.bin === 'claude' && i.args[1] === 'login');
    assert.ok(claudeLogin);
    assert.deepEqual(claudeLogin.args, ['auth', 'login', '--email', 'me@example.com']);
    assert.equal(claudeLogin.hasAnthropicKey, false, 'ANTHROPIC_API_KEY must be removed from child env');
    assert.equal(claudeLogin.hasOpenaiKey, false, 'OPENAI_API_KEY must be removed from child env');
    assert.ok(claudeLogin.configDir && claudeLogin.configDir.endsWith(path.join('claude', 'personal')));

    const codexLogin = invocations.find((i) => i.bin === 'codex' && i.args[0] === 'login' && i.args[1] !== 'status');
    assert.ok(codexLogin);
    assert.deepEqual(codexLogin.args, ['login', '--device-auth']);
  } finally {
    fakeBin.cleanup();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('add removes newly created profile dir if login check fails', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clispare-add-fail-'));
  const fakeBin = createFakeBinDir();
  try {
    // Fake claude where auth status exits 1
    fakeBin.writeCli(
      'claude',
      `
      const args = process.argv.slice(2);
      if (args[0] === 'auth' && args[1] === 'status') {
        process.exit(1);
      }
      process.exit(0);
      `
    );

    const env = makeEnvWithBin(fakeBin.dir, homeDir);
    const res = await runScriptedAdd(['claude', 'badlogin', 'me@example.com', 'done', ''], env, homeDir);
    assert.equal(res.code, 0);
    assert.equal(listAccounts(homeDir).length, 0);

    const profileDir = getProfileDir('claude', 'badlogin', homeDir);
    assert.equal(fs.existsSync(profileDir), false, 'Failed login profile dir must be removed');
  } finally {
    fakeBin.cleanup();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('add scripted via stdin pipe: firstrun, apikey, custom, invalid choice, "done" as name, and EOF ending', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clispare-add-kinds-'));
  const fakeBin = createFakeBinDir();
  const secretDeepseek = 'sk-deepseek-super-secret-value-12345';
  const secretCustom = 'sk-custom-super-secret-value-67890';

  try {
    fakeBin.writeCli('agy', 'process.exit(0);');
    const env = makeEnvWithBin(fakeBin.dir, homeDir);

    const scripted = [
      '999',                              // invalid choice
      'not-a-service',                    // invalid choice
      '4',                                // 4) agy (firstrun)
      'main',                             // account name
      '',                                 // press Enter to record
      'me@example.com',                   // id
      '4',                                // 4) agy again
      'skipped_acct',                     // account name
      'no-not-yet',                       // anything except empty/y/yes/signed skips
      '10',                               // 10) deepseek (apikey)
      'primary',                          // account name
      secretDeepseek,                     // API key (must not echo!)
      'ds@example.com',                   // id
      '16',                               // 16) custom service (API key)
      'myllm',                            // custom service name
      'prod',                             // account name
      'MYLLM_API_KEY',                    // env var name
      'http://127.0.0.1:59999/v1/chat',   // endpoint URL
      'my-model-v1',                      // default model
      secretCustom,                       // API key (must not echo!)
      'custom@example.com',               // id
      '10',                               // 10) deepseek
      'done',                             // "done" at the name prompt must cancel and NOT create "done"
    ];
    // Notice no trailing "done" after cancelling at the name prompt -> ends on EOF!

    const res = await runScriptedAdd(scripted, env, homeDir);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /Invalid choice "999"/);
    assert.match(res.stdout, /Invalid choice "not-a-service"/);
    assert.match(res.stdout, /we do not verify/i);
    assert.match(res.stdout, /https:\/\/platform\.deepseek\.com\/api_keys/);

    // Keys must never appear in stdout, stderr, or accounts.json
    assert.ok(!res.stdout.includes(secretDeepseek), 'DeepSeek key must never be echoed to stdout');
    assert.ok(!res.stderr.includes(secretDeepseek), 'DeepSeek key must never be in stderr');
    assert.ok(!res.stdout.includes(secretCustom), 'Custom key must never be echoed to stdout');
    assert.ok(!res.stderr.includes(secretCustom), 'Custom key must never be in stderr');

    const rawReg = fs.readFileSync(getAccountsPath(homeDir), 'utf8');
    assert.ok(!rawReg.includes(secretDeepseek));
    assert.ok(!rawReg.includes(secretCustom));

    const accounts = listAccounts(homeDir);
    assert.equal(accounts.length, 3);
    assert.ok(!accounts.some((a) => a.name === 'done'), 'Must never create an account called "done"');
    assert.ok(!accounts.some((a) => a.name === 'skipped_acct'), 'Skipped firstrun must not be recorded');

    assert.equal(accounts[0].service, 'agy');
    assert.equal(accounts[0].name, 'main');
    assert.equal(accounts[0].kind, 'firstrun');

    assert.equal(accounts[1].service, 'deepseek');
    assert.equal(accounts[1].name, 'primary');
    assert.equal(readKeyFile('deepseek', 'primary', homeDir), secretDeepseek);

    assert.equal(accounts[2].service, 'myllm');
    assert.equal(accounts[2].name, 'prod');
    assert.equal(accounts[2].env, 'MYLLM_API_KEY');
    assert.equal(accounts[2].endpoint, 'http://127.0.0.1:59999/v1/chat');
    assert.equal(accounts[2].model, 'my-model-v1');
    assert.equal(readKeyFile('myllm', 'prod', homeDir), secretCustom);
  } finally {
    fakeBin.cleanup();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
