'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  cleanCredentialEnv,
  resolveBinary,
  isCmdOrBat,
} = require('../util');
const { getService } = require('../services');

const DEFAULT_TIMEOUT_MS = 600 * 1000;

function buildChildEnv(service, account, baseEnv = process.env) {
  const extra = {};
  const envVar = (service && service.envDir) || (account && account.kind === 'login' && account.env);
  if (envVar && account && account.location) {
    extra[envVar] = account.location;
  }
  return cleanCredentialEnv(baseEnv, extra);
}

function killProcessTree(child, platform = process.platform) {
  if (!child || !child.pid) return;
  if (platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (_) {}
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (_) {}
  }
  try {
    child.kill('SIGKILL');
  } catch (_) {}
}

function formatSpawnCommand(resolvedBin, useShell) {
  if (useShell && resolvedBin.includes(' ') && !resolvedBin.startsWith('"')) {
    return `"${resolvedBin}"`;
  }
  return resolvedBin;
}

function escapeShellArg(arg) {
  const str = String(arg);
  if (str.includes(' ') && !str.startsWith('"')) {
    return `"${str}"`;
  }
  return str;
}

function runCliProcess({
  resolvedBin,
  args = [],
  stdinText = null,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  platform = process.platform,
}) {
  return new Promise((resolve) => {
    const useShell = isCmdOrBat(resolvedBin);
    const cmd = formatSpawnCommand(resolvedBin, useShell);

    let child;
    try {
      if (useShell) {
        const fullCmd = args && args.length > 0 ? `${cmd} ${args.map(escapeShellArg).join(' ')}` : cmd;
        child = spawn(fullCmd, {
          env,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } else {
        child = spawn(resolvedBin, args, {
          env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      }
    } catch (err) {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: err && err.message ? err.message : String(err),
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killProcessTree(child, platform);
          }, timeoutMs)
        : null;

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${err && err.message ? err.message : String(err)}`.trim(),
        timedOut,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const finalStderr = timedOut
        ? `${stderr}\nProcess timed out after ${timeoutMs}ms (ETIMEDOUT)`.trim()
        : stderr;
      resolve({
        exitCode: timedOut ? 124 : typeof code === 'number' ? code : 1,
        stdout,
        stderr: finalStderr,
        timedOut,
      });
    });

    if (child.stdin) {
      child.stdin.on('error', () => {});
      if (stdinText !== null && stdinText !== undefined) {
        child.stdin.write(String(stdinText));
      }
      child.stdin.end();
    }
  });
}

async function runHeadlessCli({
  service,
  account,
  prompt,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  platform = process.platform,
}) {
  const svc = typeof service === 'string' ? getService(service, account) : service;
  if (!svc || !svc.headless) {
    return {
      ok: false,
      skipped: true,
      reason: 'no headless adapter',
      exitCode: 1,
      stdout: '',
      stderr: `Service "${svc ? svc.id : service}" does not have a headless adapter in v0.1`,
    };
  }

  const resolvedBin = resolveBinary(svc.bin, env, platform);
  if (!resolvedBin) {
    return {
      ok: false,
      skipped: true,
      reason: 'not installed',
      exitCode: 127,
      stdout: '',
      stderr: `Binary "${svc.bin}" not found on PATH`,
    };
  }

  const childEnv = buildChildEnv(svc, account, env);
  const shim = isCmdOrBat(resolvedBin);

  // Spec: A .cmd or .bat shim must run with shell:true and the prompt on STDIN only (never in argv);
  // real executables use shell:false with args. Pass the prompt via stdin where the service says stdin,
  // else as an argument.
  let args;
  let stdinText;
  if (shim || svc.headless.input === 'stdin') {
    args = [...svc.headless.args];
    stdinText = prompt;
  } else {
    args = [...svc.headless.args, prompt];
    stdinText = null;
  }

  const res = await runCliProcess({
    resolvedBin,
    args,
    stdinText,
    env: childEnv,
    timeoutMs,
    platform,
  });

  return {
    ok: res.exitCode === 0 && !res.timedOut,
    exitCode: res.exitCode,
    stdout: res.stdout,
    output: res.stdout,
    stderr: res.stderr,
    timedOut: res.timedOut,
    usedShell: shim,
    argsPassed: args,
  };
}

async function checkLoginStatus({
  service,
  account,
  env = process.env,
  timeoutMs = 15000,
  platform = process.platform,
}) {
  const svc = typeof service === 'string' ? getService(service, account) : service;
  if (!svc) return false;

  if (svc.checkType === 'file') {
    const profileDir = account && account.location;
    if (!profileDir) return false;
    const authFile = path.join(profileDir, svc.checkFile || 'auth.json');
    try {
      const st = fs.statSync(authFile);
      if (!st.isFile() || st.size === 0) return false;
      const content = fs.readFileSync(authFile, 'utf8').trim();
      return content.length > 0;
    } catch (_) {
      return false;
    }
  }

  const resolvedBin = resolveBinary(svc.bin, env, platform);
  if (!resolvedBin) return false;

  const childEnv = buildChildEnv(svc, account, env);
  const res = await runCliProcess({
    resolvedBin,
    args: svc.checkArgs || ['auth', 'status'],
    stdinText: null,
    env: childEnv,
    timeoutMs,
    platform,
  });

  if (svc.checkType === 'exit0') {
    return res.exitCode === 0;
  }

  if (svc.checkType === 'codex-status') {
    const combined = `${res.stdout}\n${res.stderr}`.toLowerCase();
    return combined.includes('logged in') && !combined.includes('not logged in');
  }

  return res.exitCode === 0;
}

function spawnInteractiveCli({
  service,
  account,
  args = [],
  env = process.env,
  stdio = 'inherit',
  platform = process.platform,
}) {
  const svc = typeof service === 'string' ? getService(service, account) : service;
  if (!svc || !svc.bin) {
    return Promise.reject(new Error(`Unknown CLI binary for service "${service}"`));
  }

  const resolvedBin = resolveBinary(svc.bin, env, platform);
  if (!resolvedBin) {
    return Promise.reject(new Error(`Binary "${svc.bin}" is not installed or not on PATH`));
  }

  const childEnv = buildChildEnv(svc, account, env);
  const useShell = isCmdOrBat(resolvedBin);
  const cmd = formatSpawnCommand(resolvedBin, useShell);

  return new Promise((resolve, reject) => {
    let child;
    try {
      if (useShell) {
        const fullCmd = args && args.length > 0 ? `${cmd} ${args.map(escapeShellArg).join(' ')}` : cmd;
        child = spawn(fullCmd, {
          env: childEnv,
          shell: true,
          stdio,
          windowsHide: true,
        });
      } else {
        child = spawn(resolvedBin, args, {
          env: childEnv,
          shell: false,
          stdio,
          windowsHide: true,
        });
      }
    } catch (err) {
      reject(err);
      return;
    }

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  buildChildEnv,
  killProcessTree,
  runCliProcess,
  runHeadlessCli,
  checkLoginStatus,
  spawnInteractiveCli,
};
