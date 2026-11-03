'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../package.json');
const {
  getHomeDir,
  ensureHomeDir,
  getActiveCredentialEnvVars,
  resolveBinary,
  formatTime,
  formatDuration,
} = require('./util');
const {
  SERVICES,
  getService,
} = require('./services');
const {
  listAccounts,
  getAccount,
  getDefaultAccount,
  removeAccount,
  setDefaultAccount,
  readKeyFile,
} = require('./registry');
const {
  readState,
  getCooldown,
  resetCooldowns,
} = require('./state');
const {
  checkLoginStatus,
  spawnInteractiveCli,
} = require('./adapters/cli');
const { runAddLoop } = require('./add');
const { runWithFailover } = require('./runner');

const COMMAND_HELP = {
  add: `Usage: clispare add [service]

Interactively sign in to AI coding CLIs or register API keys.
Prints a numbered menu of the 15 built-in services plus custom API-key services,
guides through sign-in or key entry, and repeats until "done" or EOF.`,

  list: `Usage: clispare list [--json]

List all configured accounts with account ID, default marker, and the shell
command to activate or use each account (PowerShell on Windows, POSIX otherwise).
Never prints API keys.`,

  remove: `Usage: clispare remove <service> <name> [--purge]

Remove an account from the registry and delete its key file.
For login profiles, prints the profile folder path and leaves it intact unless --purge is passed.`,

  default: `Usage: clispare default <service> <name>

Mark the specified account as the default account that "clispare run" uses for <service>.`,

  status: `Usage: clispare status [--json]

Show a status table of services and accounts: whether the CLI binary is installed,
whether the account is signed in (or key file is present / not verified), and any active cooldown.`,

  use: `Usage: clispare use <service>[:name] [-- args...]

Spawn the real CLI interactively with the isolated profile environment variable set
and conflicting credential environment variables removed.
For API-key accounts, prints the shell export line without revealing the key.`,

  run: `Usage: clispare run [--engines a,b,c] [--lane service:name]... [--timeout SEC] [--json] [--verbose] [prompt...]

Run a prompt headlessly with automatic failover across different services.
Uses at most one account per service. Reads the prompt from arguments or stdin.
Exit codes:
  0   Success
  1   Fatal task error (never fails over)
  2   Bad usage
  75  Every usable lane is cooling down or rate-limited
  77  Nothing is signed in or no usable lane`,

  reset: `Usage: clispare reset [service[:name]]

Clear active cooldowns for all lanes, a specific service, or a specific service:name lane.`,

  doctor: `Usage: clispare doctor

Check Node.js version (>=18), installed CLI binaries on PATH, credential environment
variable warnings, and data directory / key file permissions.`,

  help: `Usage: clispare help [command]

Display general help or detailed help for a specific command.`,
};

function getMainHelp() {
  return `clispare v${pkg.version}
${pkg.description}

Usage:
  clispare <command> [options]

Commands:
  add [service]                        Interactive loop to add CLI logins or API keys
  list [--json]                        List registered accounts and usage commands
  remove <service> <name> [--purge]    Remove an account (and profile folder with --purge)
  default <service> <name>             Set the default account for a service
  status [--json]                      Show installation, sign-in, and cooldown status
  use <service>[:name] [-- args...]    Launch a CLI interactively or print API key export command
  run [options] [prompt...]            Run a prompt headlessly with failover across services
  reset [service[:name]]               Clear cooldown state
  doctor                               Check Node version, binaries, env vars, and permissions
  help [command]                       Show help for a command

Global Options:
  -h, --help                           Show help
  -v, --version                        Show version
`;
}

function formatUseCommand(account, platform = process.platform) {
  const svc = getService(account.service, account);
  const bin = (svc && svc.bin) || account.service;

  if (account.kind === 'login') {
    const envVar = account.env || (svc && svc.envDir) || 'PROFILE_DIR';
    if (platform === 'win32') {
      return `$env:${envVar}="${account.location}"; ${bin}`;
    }
    return `${envVar}="${account.location}" ${bin}`;
  }

  if (account.kind === 'apikey') {
    const envVar =
      account.env ||
      (svc && svc.env) ||
      `${account.service.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
    if (platform === 'win32') {
      return `$env:${envVar}=(Get-Content -Raw "${account.location}").Trim()`;
    }
    return `export ${envVar}="$(cat "${account.location}")"`;
  }

  return bin;
}

function readAllStdin(stdin) {
  return new Promise((resolve) => {
    if (!stdin || stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    stdin.on('data', (chunk) => {
      data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    stdin.on('end', () => resolve(data));
    stdin.on('error', () => resolve(data));
    if (typeof stdin.resume === 'function') {
      stdin.resume();
    }
  });
}

function parseServiceAndName(args) {
  const clean = args.filter((a) => !a.startsWith('-'));
  if (clean.length === 0) return { service: null, name: null };
  if (clean[0].includes(':')) {
    const idx = clean[0].indexOf(':');
    return {
      service: clean[0].slice(0, idx).trim(),
      name: clean[0].slice(idx + 1).trim(),
    };
  }
  return {
    service: clean[0] ? clean[0].trim() : null,
    name: clean[1] ? clean[1].trim() : null,
  };
}

async function handleList(args, ctx) {
  const isJson = args.includes('--json');
  const unknown = args.filter((a) => a !== '--json');
  if (unknown.length > 0) {
    ctx.writeErr(`Unknown argument for list: ${unknown[0]}\n`);
    return 2;
  }

  const accounts = listAccounts(ctx.homeDir);
  const items = accounts.map((acc) => ({
    service: acc.service,
    name: acc.name,
    id: acc.id || '',
    kind: acc.kind,
    default: Boolean(acc.default),
    command: formatUseCommand(acc, ctx.platform),
    added: acc.added,
  }));

  if (isJson) {
    ctx.writeOut(JSON.stringify(items, null, 2) + '\n');
    return 0;
  }

  if (items.length === 0) {
    ctx.writeOut('No accounts configured. Run "clispare add" to add one.\n');
    return 0;
  }

  for (const item of items) {
    const defMarker = item.default ? ' (default)' : '';
    const idPart = item.id ? ` [${item.id}]` : '';
    ctx.writeOut(`${item.service}:${item.name}${defMarker}${idPart} (${item.kind})\n`);
    ctx.writeOut(`  Command: ${item.command}\n`);
  }
  return 0;
}

async function handleRemove(args, ctx) {
  const purge = args.includes('--purge');
  const badFlag = args.find((a) => a.startsWith('-') && a !== '--purge');
  if (badFlag) {
    ctx.writeErr(`Unknown option for remove: ${badFlag}\n`);
    return 2;
  }

  const { service, name } = parseServiceAndName(args);
  if (!service || !name) {
    ctx.writeErr('Usage: clispare remove <service> <name> [--purge]\n');
    return 2;
  }

  try {
    const removed = removeAccount(service, name, { purge }, ctx.homeDir);
    resetCooldowns(`${removed.service}:${removed.name}`, ctx.homeDir);
    ctx.writeOut(`Removed ${removed.service}:${removed.name}.\n`);
    if (removed.kind === 'login' && removed.location) {
      if (purge) {
        ctx.writeOut(`Purged profile folder: ${removed.location}\n`);
      } else {
        ctx.writeOut(`Profile folder kept at: ${removed.location} (use --purge to delete)\n`);
      }
    }
    return 0;
  } catch (err) {
    ctx.writeErr(`${err.message}\n`);
    return 1;
  }
}

async function handleDefault(args, ctx) {
  const badFlag = args.find((a) => a.startsWith('-'));
  if (badFlag) {
    ctx.writeErr(`Unknown option for default: ${badFlag}\n`);
    return 2;
  }

  const { service, name } = parseServiceAndName(args);
  if (!service || !name) {
    ctx.writeErr('Usage: clispare default <service> <name>\n');
    return 2;
  }

  try {
    const updated = setDefaultAccount(service, name, ctx.homeDir);
    ctx.writeOut(`Default account for ${updated.service} set to "${updated.name}".\n`);
    return 0;
  } catch (err) {
    ctx.writeErr(`${err.message}\n`);
    return 1;
  }
}

async function handleStatus(args, ctx) {
  const isJson = args.includes('--json');
  const unknown = args.filter((a) => a !== '--json');
  if (unknown.length > 0) {
    ctx.writeErr(`Unknown argument for status: ${unknown[0]}\n`);
    return 2;
  }

  const accounts = listAccounts(ctx.homeDir);
  const now = Date.now();
  const rows = [];

  for (const acc of accounts) {
    const svc = getService(acc.service, acc);
    let installed = 'n/a';
    let signedIn = 'no';

    if (acc.kind === 'login') {
      const bin = (svc && svc.bin) || acc.service;
      const binPath = resolveBinary(bin, ctx.env, ctx.platform);
      installed = binPath ? 'yes' : 'no';
      if (binPath && svc) {
        const ok = await checkLoginStatus({
          service: svc,
          account: acc,
          env: ctx.env,
          platform: ctx.platform,
        });
        signedIn = ok ? 'yes' : 'no';
      }
    } else if (acc.kind === 'firstrun') {
      const bin = (svc && svc.bin) || acc.service;
      const binPath = resolveBinary(bin, ctx.env, ctx.platform);
      installed = binPath ? 'yes' : 'no';
      signedIn = 'not verified';
    } else if (acc.kind === 'apikey') {
      installed = 'n/a';
      const key = readKeyFile(acc.service, acc.name, ctx.homeDir);
      signedIn = key ? 'key present' : 'missing key';
    }

    const cd = getCooldown(acc.service, acc.name, ctx.homeDir, now);
    const cooldownText =
      cd && cd.until > now
        ? `${cd.reason} (${formatDuration(cd.until - now)} left, until ${formatTime(cd.until)})`
        : 'none';

    rows.push({
      service: acc.service,
      name: acc.name,
      id: acc.id || '',
      kind: acc.kind,
      default: Boolean(acc.default),
      installed,
      signedIn,
      cooldown: cd && cd.until > now ? { reason: cd.reason, until: cd.until, remainingMs: cd.until - now } : null,
      cooldownText,
    });
  }

  // Also include catalogue status summary if no accounts exist
  const servicesSummary = SERVICES.map((s) => {
    const installed = s.bin ? Boolean(resolveBinary(s.bin, ctx.env, ctx.platform)) : null;
    return {
      service: s.id,
      kind: s.kind,
      bin: s.bin || null,
      installed,
    };
  });

  if (isJson) {
    ctx.writeOut(JSON.stringify({ accounts: rows, services: servicesSummary }, null, 2) + '\n');
    return 0;
  }

  ctx.writeOut('Accounts Status:\n');
  if (rows.length === 0) {
    ctx.writeOut('  (no accounts registered)\n');
  } else {
    ctx.writeOut(
      '  LANE                 KIND       INSTALLED  SIGNED IN      COOLDOWN\n'
    );
    for (const r of rows) {
      const laneLabel = `${r.service}:${r.name}${r.default ? '*' : ''}`.padEnd(20, ' ');
      const kindLabel = r.kind.padEnd(10, ' ');
      const instLabel = String(r.installed).padEnd(10, ' ');
      const signLabel = String(r.signedIn).padEnd(14, ' ');
      ctx.writeOut(`  ${laneLabel} ${kindLabel} ${instLabel} ${signLabel} ${r.cooldownText}\n`);
    }
  }
  return 0;
}

async function handleUse(args, ctx) {
  let sepIdx = args.indexOf('--');
  let targetArg;
  let passArgs = [];

  if (sepIdx !== -1) {
    const before = args.slice(0, sepIdx);
    passArgs = args.slice(sepIdx + 1);
    targetArg = before[0];
  } else {
    targetArg = args[0];
    passArgs = args.slice(1);
  }

  if (!targetArg || targetArg.startsWith('-')) {
    ctx.writeErr('Usage: clispare use <service>[:name] [-- args...]\n');
    return 2;
  }

  let service;
  let name = null;
  if (targetArg.includes(':')) {
    const idx = targetArg.indexOf(':');
    service = targetArg.slice(0, idx).trim().toLowerCase();
    name = targetArg.slice(idx + 1).trim();
  } else {
    service = targetArg.trim().toLowerCase();
  }

  const acc = name
    ? getAccount(service, name, ctx.homeDir)
    : getDefaultAccount(service, ctx.homeDir);

  if (!acc) {
    ctx.writeErr(`No account found for "${targetArg}".\n`);
    return 1;
  }

  if (acc.kind === 'apikey') {
    ctx.writeOut(formatUseCommand(acc, ctx.platform) + '\n');
    return 0;
  }

  const svc = getService(acc.service, acc);
  try {
    const code = await spawnInteractiveCli({
      service: svc,
      account: acc,
      args: passArgs,
      env: ctx.env,
      stdio: 'inherit',
      platform: ctx.platform,
    });
    return code;
  } catch (err) {
    ctx.writeErr(`${err.message}\n`);
    return 1;
  }
}

async function handleRun(args, ctx) {
  let engines = null;
  const lanes = [];
  let timeoutSec = 600;
  let json = false;
  let verbose = false;
  const promptParts = [];

  let i = 0;
  let parsingFlags = true;
  while (i < args.length) {
    const arg = args[i];
    if (parsingFlags && arg === '--') {
      parsingFlags = false;
      i++;
      continue;
    }
    if (parsingFlags && arg.startsWith('-')) {
      if (arg === '--json') {
        json = true;
        i++;
        continue;
      }
      if (arg === '--verbose' || arg === '-v') {
        verbose = true;
        i++;
        continue;
      }
      if (arg === '--engines' || arg.startsWith('--engines=')) {
        const val = arg.includes('=') ? arg.slice('--engines='.length) : args[++i];
        if (!val || !val.trim()) {
          ctx.writeErr('Error: --engines requires a comma-separated list of services\n');
          return 2;
        }
        engines = val
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        i++;
        continue;
      }
      if (arg === '--lane' || arg.startsWith('--lane=')) {
        const val = arg.includes('=') ? arg.slice('--lane='.length) : args[++i];
        if (!val || !val.includes(':')) {
          ctx.writeErr('Error: --lane requires <service>:<name>\n');
          return 2;
        }
        lanes.push(val.trim());
        i++;
        continue;
      }
      if (arg === '--timeout' || arg.startsWith('--timeout=')) {
        const val = arg.includes('=') ? arg.slice('--timeout='.length) : args[++i];
        const num = Number(val);
        if (!val || Number.isNaN(num) || num <= 0) {
          ctx.writeErr('Error: --timeout requires a positive number of seconds\n');
          return 2;
        }
        timeoutSec = num;
        i++;
        continue;
      }
      ctx.writeErr(`Unknown option for run: ${arg}\n`);
      return 2;
    }
    promptParts.push(arg);
    i++;
  }

  let prompt = promptParts.join(' ');
  if (!prompt) {
    prompt = await readAllStdin(ctx.stdin);
  }

  if (!prompt || !prompt.trim()) {
    ctx.writeErr('Error: No prompt provided. Pass a prompt as arguments or via stdin.\n');
    return 2;
  }

  const res = await runWithFailover({
    prompt,
    engines,
    lanes,
    timeoutMs: Math.round(timeoutSec * 1000),
    json,
    verbose,
    homeDir: ctx.homeDir,
    env: ctx.env,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    platform: ctx.platform,
  });

  return res.exitCode;
}

async function handleReset(args, ctx) {
  const badFlag = args.find((a) => a.startsWith('-'));
  if (badFlag) {
    ctx.writeErr(`Unknown option for reset: ${badFlag}\n`);
    return 2;
  }
  if (args.length > 2) {
    ctx.writeErr('Usage: clispare reset [service[:name]]\n');
    return 2;
  }

  let target = null;
  if (args.length === 2) {
    target = `${args[0]}:${args[1]}`;
  } else if (args.length === 1) {
    target = args[0];
  }

  resetCooldowns(target, ctx.homeDir);
  ctx.writeOut(target ? `Cleared cooldowns for ${target}.\n` : 'Cleared all cooldowns.\n');
  return 0;
}

async function handleDoctor(args, ctx) {
  if (args.length > 0) {
    ctx.writeErr(`Unknown option for doctor: ${args[0]}\n`);
    return 2;
  }

  const nodeVer = process.versions.node;
  const major = Number(nodeVer.split('.')[0]);
  const nodeOk = major >= 18;
  ctx.writeOut(`Node.js version: v${nodeVer} (${nodeOk ? 'OK, >= 18' : 'FAIL, requires >= 18'})\n`);

  ensureHomeDir(ctx.homeDir);
  let dirModeStr = 'exists';
  try {
    const st = fs.statSync(ctx.homeDir);
    const perm = (st.mode & 0o777).toString(8).padStart(4, '0');
    dirModeStr = `mode ${perm}`;
  } catch (_) {}
  ctx.writeOut(`Data directory: ${ctx.homeDir} (${dirModeStr})\n`);

  const activeCreds = getActiveCredentialEnvVars(ctx.env);
  if (activeCreds.length > 0) {
    ctx.writeOut(
      `Warning: Credential environment variables set: ${activeCreds.join(', ')}\n`
    );
  } else {
    ctx.writeOut('Credential environment variables: clean (none set)\n');
  }

  ctx.writeOut('CLI binaries on PATH:\n');
  for (const svc of SERVICES) {
    if (!svc.bin) continue;
    const found = resolveBinary(svc.bin, ctx.env, ctx.platform);
    ctx.writeOut(`  ${svc.id.padEnd(10, ' ')} (${svc.bin}): ${found ? found : 'not found'}\n`);
  }

  const state = readState(ctx.homeDir);
  const activeCount = Object.keys(state).length;
  ctx.writeOut(`Active cooldowns: ${activeCount}\n`);

  return nodeOk ? 0 : 1;
}

async function runCli(argv = process.argv.slice(2), options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || getHomeDir(env);
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const platform = options.platform || process.platform;

  const ctx = {
    env,
    homeDir,
    stdin,
    stdout,
    stderr,
    platform,
    writeOut: (t) => stdout && typeof stdout.write === 'function' && stdout.write(t),
    writeErr: (t) => stderr && typeof stderr.write === 'function' && stderr.write(t),
  };

  if (!Array.isArray(argv) || argv.length === 0) {
    ctx.writeOut(getMainHelp());
    return 0;
  }

  const first = argv[0];
  const rest = argv.slice(1);

  if (first === '--version' || first === '-v') {
    ctx.writeOut(`${pkg.version}\n`);
    return 0;
  }

  if (first === '--help' || first === '-h') {
    ctx.writeOut(getMainHelp());
    return 0;
  }

  if (first === 'help') {
    if (rest.length === 0) {
      ctx.writeOut(getMainHelp());
      return 0;
    }
    const targetCmd = rest[0].toLowerCase();
    if (COMMAND_HELP[targetCmd]) {
      ctx.writeOut(COMMAND_HELP[targetCmd] + '\n');
      return 0;
    }
    ctx.writeErr(`Unknown command "${rest[0]}".\n`);
    return 2;
  }

  // Per-command --help support
  if (rest.includes('--help') || rest.includes('-h')) {
    if (COMMAND_HELP[first]) {
      ctx.writeOut(COMMAND_HELP[first] + '\n');
      return 0;
    }
  }

  switch (first) {
    case 'add': {
      if (rest.length > 1 || (rest[0] && rest[0].startsWith('-'))) {
        ctx.writeErr('Usage: clispare add [service]\n');
        return 2;
      }
      return runAddLoop({
        initialService: rest[0] || null,
        homeDir,
        env,
        stdin,
        stdout,
        stderr,
        platform,
      });
    }
    case 'list':
      return handleList(rest, ctx);
    case 'remove':
      return handleRemove(rest, ctx);
    case 'default':
      return handleDefault(rest, ctx);
    case 'status':
      return handleStatus(rest, ctx);
    case 'use':
      return handleUse(rest, ctx);
    case 'run':
      return handleRun(rest, ctx);
    case 'reset':
      return handleReset(rest, ctx);
    case 'doctor':
      return handleDoctor(rest, ctx);
    default:
      ctx.writeErr(`Unknown command "${first}". Run "clispare --help" for usage.\n`);
      return 2;
  }
}

module.exports = {
  COMMAND_HELP,
  getMainHelp,
  formatUseCommand,
  runCli,
};
