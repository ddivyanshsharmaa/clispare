'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../src/cli');
const { addAccount, getAccountsPath } = require('../src/registry');
const { readState, getStatePath } = require('../src/state');

function createFakeBinDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clispare-runbin-'));
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

function makeEnv(binDir, homeDir, extra = {}) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const origPath = process.env.PATH || process.env.Path || '';
  return {
    ...process.env,
    PATH: `${binDir}${sep}${origPath}`,
    Path: `${binDir}${sep}${origPath}`,
    CLISPARE_HOME: homeDir,
    CLISPARE_RETRY_DELAY_MS: '50',
    ...extra,
  };
}

async function execCli(argv, env, homeDir) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    env,
    homeDir,
    stdout: { write: (s) => { stdout += String(s); } },
    stderr: { write: (s) => { stderr += String(s); } },
  });
  return { code, stdout, stderr };
}

test('failover from CLI limit to next engine, cooldown persistence, and reset', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clispare-run-limit-'));
  const fakeBin = createFakeBinDir();
  const invLog = path.join(homeDir, 'inv.json');
  fs.writeFileSync(invLog, '[]', 'utf8');

  try {
    addAccount({ service: 'claude', name: 'main', kind: 'login' }, homeDir);
    addAccount({ service: 'claude', name: 'backup', kind: 'login' }, homeDir);
    addAccount({ service: 'codex', name: 'main', kind: 'login' }, homeDir);

    // Fake claude always exits 1 with usage limit and logs its invocation
    fakeBin.writeCli(
      'claude',
      `
      const fs = require('node:fs');
      const list = JSON.parse(fs.readFileSync(${JSON.stringify(invLog)}, 'utf8'));
      list.push({
        bin: 'claude',
        configDir: process.env.CLAUDE_CONFIG_DIR,
        hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
        argv: process.argv.slice(2),
      });
      fs.writeFileSync(${JSON.stringify(invLog)}, JSON.stringify(list));
      process.stderr.write('Claude usage limit reached, resets at 11:59 PM\\n');
      process.exit(1);
      `
    );

    // Fake codex reads prompt from stdin and succeeds
    fakeBin.writeCli(
      'codex',
      `
      const fs = require('node:fs');
      const stdin = fs.readFileSync(0, 'utf8').trim();
      const list = JSON.parse(fs.readFileSync(${JSON.stringify(invLog)}, 'utf8'));
      list.push({
        bin: 'codex',
        codexHome: process.env.CODEX_HOME,
        hasOpenaiKey: Boolean(process.env.OPENAI_API_KEY),
        stdin,
      });
      fs.writeFileSync(${JSON.stringify(invLog)}, JSON.stringify(list));
      process.stdout.write('Codex answered: ' + stdin + '\\n');
      process.exit(0);
      `
    );

    const env = makeEnv(fakeBin.dir, homeDir, {
      ANTHROPIC_API_KEY: 'sk-leak-check',
      OPENAI_API_KEY: 'sk-leak-check-2',
    });

    const r1 = await execCli(['run', 'solve', 'this', 'bug'], env, homeDir);
    assert.equal(r1.code, 0);
    assert.equal(r1.stdout.trim(), 'Codex answered: solve this bug');
    assert.match(r1.stderr, /\[clispare\] claude: usage limit, cooling down until/);

    const invocations = JSON.parse(fs.readFileSync(invLog, 'utf8'));
    // Verify second account of claude ("backup") was NOT auto-used!
    const claudeRuns = invocations.filter((x) => x.bin === 'claude');
    assert.equal(claudeRuns.length, 1, 'Second account of the same service must NOT be auto-used');
    assert.equal(claudeRuns[0].hasAnthropicKey, false, 'Credential env vars must be stripped');

    // Second run should skip claude because cooldown persists in state.json
    fs.writeFileSync(invLog, '[]', 'utf8');
    const r2 = await execCli(['run', '--verbose', 'second', 'prompt'], env, homeDir);
    assert.equal(r2.code, 0);
    const inv2 = JSON.parse(fs.readFileSync(invLog, 'utf8'));
    assert.equal(inv2.filter((x) => x.bin === 'claude').length, 0, 'Cooldown must persist across runs');
    assert.match(r2.stderr, /claude:main: skipped \(cooling down/);

    // Reset clears cooldown so claude is tried again
    const rReset = await execCli(['reset', 'claude'], env, homeDir);
    assert.equal(rReset.code, 0);
    assert.deepEqual(readState(homeDir), {});

    const r3 = await execCli(['run', 'third', 'prompt'], env, homeDir);
    assert.equal(r3.code, 0);
    const inv3 = JSON.parse(fs.readFileSync(invLog, 'utf8'));
    assert.equal(inv3.filter((x) => x.bin === 'claude').length, 1, 'claude tried again after reset');
  } finally {
    fakeBin.cleanup();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('fatal error does NOT fail over and returns exit code 1', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clispare-run-fatal-'));
  const fakeBin = createFakeBinDir();
  const codexCalledFile = path.join(homeDir, 'codex-called.txt');

  try {
    addAccount({ service: 'claude', name: 'main', kind: 'login' }, homeDir);
    addAccount({ service: 'codex', name: 'main', kind: 'login' }, homeDir);

    fakeBin.writeCli(
      'claude',
      `
      process.stderr.write('Fatal Error: Invalid syntax in user request\\n');
      process.exit(1);
      `
    );

    fakeBin.writeCli(
      'codex',
      `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(codexCalledFile)}, 'called');
      process.stdout.write('Should not reach codex\\n');
      process.exit(0);
      `
    );

    const env = makeEnv(fakeBin.dir, homeDir);
    const res = await execCli(['run', 'bad prompt'], env, homeDir);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /Fatal Error: Invalid syntax/);
    assert.equal(fs.existsSync(codexCalledFile), false, 'Fatal error must NOT fail over to next engine');
  } finally {
    fakeBin.cleanup();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('transient retries once then fails over, and auth moves on with 10m cooldown', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clispare-run-trans-'));
  const fakeBin = createFakeBinDir();
  const countFile = path.join(homeDir, 'counts.json');
  fs.writeFileSync(countFile, '{"claude":0,"codex":0,"agy":0}', 'utf8');

  try {
    addAccount({ service: 'claude', name: 'main', kind: 'login' }, homeDir);
    addAccount({ service: 'codex', name: 'main', kind: 'login' }, homeDir);
    addAccount({ service: 'agy', name: 'main', kind: 'firstrun' }, homeDir);

    // claude fails with transient error on both attempts
    fakeBin.writeCli(
      'claude',
      `
      const fs = require('node:fs');
      const c = JSON.parse(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8'));
      c.claude++;
      fs.writeFileSync(${JSON.stringify(countFile)}, JSON.stringify(c));
      process.stderr.write('Server overloaded, temporarily unavailable\\n');
      process.exit(1);
      `
    );

    // codex fails with auth error
    fakeBin.writeCli(
      'codex',
      `
      const fs = require('node:fs');
      const c = JSON.parse(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8'));
      c.codex++;
      fs.writeFileSync(${JSON.stringify(countFile)}, JSON.stringify(c));
      process.stderr.write('Error: Not logged in. Please sign in.\\n');
      process.exit(1);
      `
    );

    // agy succeeds; on Windows .cmd shim receives prompt on stdin (never in argv)
    fakeBin.writeCli(
      'agy',
      `
      const fs = require('node:fs');
      const c = JSON.parse(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8'));
      c.agy++;
      c.agyArgs = process.argv.slice(2);
      const stdinPrompt = fs.readFileSync(0, 'utf8').trim();
      c.agyStdin = stdinPrompt;
      fs.writeFileSync(${JSON.stringify(countFile)}, JSON.stringify(c));
      const p = stdinPrompt || process.argv.slice(3).join(' ');
      process.stdout.write('AGY response: ' + p + '\\n');
      process.exit(0);
      `
    );

    const env = makeEnv(fakeBin.dir, homeDir);
    const res = await execCli(['run', 'hello from test'], env, homeDir);
    assert.equal(res.code, 0);
    assert.equal(res.stdout.trim(), 'AGY response: hello from test');

    const counts = JSON.parse(fs.readFileSync(countFile, 'utf8'));
    assert.equal(counts.claude, 2, 'Transient lane must be tried once + retried once = 2 times');
    assert.equal(counts.codex, 1, 'Auth lane tried once then moves on');
    assert.equal(counts.agy, 1);

    if (process.platform === 'win32') {
      // On Windows, .cmd shim must receive prompt on STDIN only, never in argv
      assert.deepEqual(counts.agyArgs, ['-p']);
      assert.equal(counts.agyStdin, 'hello from test');
    }

    const state = readState(homeDir);
    assert.equal(state['claude:main'].reason, 'transient');
    assert.equal(state['codex:main'].reason, 'auth');
  } finally {
    fakeBin.cleanup();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('all lanes cooling returns 75 with earliest reset; no usable lane returns 77', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clispare-run-codes-'));
  const fakeBin = createFakeBinDir();

  try {
    const env = makeEnv(fakeBin.dir, homeDir);

    // Empty homeDir -> nothing signed in -> 77
    const r77 = await execCli(['run', 'test prompt'], env, homeDir);
    assert.equal(r77.code, 77);

    // Add gemini (firstrun without headless adapter in v0.1) -> skipped with clear message -> 77
    fakeBin.writeCli('gemini', 'process.exit(0);');
    addAccount({ service: 'gemini', name: 'main', kind: 'firstrun' }, homeDir);
    const r77Skip = await execCli(['run', 'test prompt'], env, homeDir);
    assert.equal(r77Skip.code, 77);
    assert.match(r77Skip.stderr, /gemini: skipped \(no headless adapter/);

    // Add claude that hits limit -> returns 75 with earliest reset
    fakeBin.writeCli(
      'claude',
      `
      process.stderr.write('Rate limit exceeded, try again in 45m\\n');
      process.exit(1);
      `
    );
    addAccount({ service: 'claude', name: 'main', kind: 'login' }, homeDir);

    const r75First = await execCli(['run', 'test prompt'], env, homeDir);
    assert.equal(r75First.code, 75);
    assert.match(r75First.stderr, /Earliest reset/i);

    // Subsequent call while claude is cooling in state.json also returns 75 with earliest reset
    const r75Second = await execCli(['run', 'test prompt'], env, homeDir);
    assert.equal(r75Second.code, 75);
    assert.match(r75Second.stderr, /Earliest reset/i);
  } finally {
    fakeBin.cleanup();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('HTTP adapter failover across 429 (with Retry-After), 402, 401, 503, and 200 without leaking keys', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clispare-run-http-'));
  const fakeBin = createFakeBinDir();

  const keys = {
    deepseek: 'sk-deepseek-secret-key-alpha-111',
    openrouter: 'sk-openrouter-secret-key-beta-222',
    groq: 'sk-groq-secret-key-gamma-333',
    mistral: 'sk-mistral-secret-key-delta-444',
  };

  let mistralCalls = 0;
  const authHeadersSeen = {};

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      authHeadersSeen[req.url] = req.headers.authorization;

      if (req.url === '/deepseek') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '120',
        });
        res.end(JSON.stringify({ error: { message: `Rate limit for ${keys.deepseek}` } }));
        return;
      }
      if (req.url === '/openrouter') {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Insufficient credits' } }));
        return;
      }
      if (req.url === '/groq') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Invalid key ${keys.groq}` } }));
        return;
      }
      if (req.url === '/mistral') {
        mistralCalls++;
        if (mistralCalls === 1) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Backend temporarily unavailable' } }));
          return;
        }
        const parsed = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: `Mistral [${parsed.model}] reply to: ${parsed.messages[0].content}`,
                },
              },
            ],
          })
        );
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    addAccount({ service: 'deepseek', name: 'main', kind: 'apikey', key: keys.deepseek }, homeDir);
    addAccount({ service: 'openrouter', name: 'main', kind: 'apikey', key: keys.openrouter }, homeDir);
    addAccount({ service: 'groq', name: 'main', kind: 'apikey', key: keys.groq }, homeDir);
    addAccount({ service: 'mistral', name: 'main', kind: 'apikey', key: keys.mistral }, homeDir);

    const env = makeEnv(fakeBin.dir, homeDir, {
      CLISPARE_BASE_DEEPSEEK: `${base}/deepseek`,
      CLISPARE_BASE_OPENROUTER: `${base}/openrouter`,
      CLISPARE_BASE_GROQ: `${base}/groq`,
      CLISPARE_BASE_MISTRAL: `${base}/mistral`,
      CLISPARE_MODEL_MISTRAL: 'mistral-custom-test',
    });

    const before = Date.now();
    const res = await execCli(['run', 'explain closures'], env, homeDir);
    assert.equal(res.code, 0);
    assert.equal(res.stdout, 'Mistral [mistral-custom-test] reply to: explain closures');
    assert.equal(mistralCalls, 2, 'Mistral 503 should retry once and succeed on 2nd try');

    assert.equal(authHeadersSeen['/deepseek'], `Bearer ${keys.deepseek}`);
    assert.equal(authHeadersSeen['/mistral'], `Bearer ${keys.mistral}`);

    const state = readState(homeDir);
    // deepseek 429 with Retry-After: 120 -> ~120s cooldown
    const dsCooldownMs = state['deepseek:main'].until - before;
    assert.ok(dsCooldownMs >= 115000 && dsCooldownMs <= 130000, `Expected ~120s cooldown, got ${dsCooldownMs}`);
    // openrouter 402 -> ~24h cooldown
    const orCooldownMs = state['openrouter:main'].until - before;
    assert.ok(orCooldownMs >= 23 * 3600 * 1000);
    // groq 401 -> auth cooldown (~10m)
    assert.equal(state['groq:main'].reason, 'auth');

    // Ensure NO key appears anywhere in stdout, stderr, state.json, or accounts.json
    const rawState = fs.readFileSync(getStatePath(homeDir), 'utf8');
    const rawAccounts = fs.readFileSync(getAccountsPath(homeDir), 'utf8');
    for (const secret of Object.values(keys)) {
      assert.ok(!res.stdout.includes(secret), 'Key must not appear in stdout');
      assert.ok(!res.stderr.includes(secret), 'Key must not appear in stderr');
      assert.ok(!rawState.includes(secret), 'Key must not appear in state.json');
      assert.ok(!rawAccounts.includes(secret), 'Key must not appear in accounts.json');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fakeBin.cleanup();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
