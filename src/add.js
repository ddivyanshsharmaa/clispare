'use strict';

const fs = require('node:fs');
const {
  getHomeDir,
  ensureDir,
  getActiveCredentialEnvVars,
  resolveBinary,
  createLineReader,
} = require('./util');
const {
  SERVICES,
  getService,
} = require('./services');
const {
  isCancelWord,
  sanitizeName,
  getProfileDir,
  getAccount,
  addAccount,
} = require('./registry');
const {
  checkLoginStatus,
  spawnInteractiveCli,
} = require('./adapters/cli');

const END_LOOP_WORDS = new Set([
  'done',
  'd',
  'quit',
  'exit',
  'q',
  'finish',
  'stop',
  'no',
  'n',
]);

function printServiceMenu(writeOut) {
  writeOut('\nAvailable services:\n');
  SERVICES.forEach((svc, idx) => {
    const num = String(idx + 1).padStart(2, ' ');
    writeOut(`  ${num}) ${svc.id} (${svc.kind})\n`);
  });
  writeOut('  16) another service (API key)\n');
}

async function runAddLoop({
  initialService = null,
  homeDir = null,
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  platform = process.platform,
} = {}) {
  const resolvedHome = homeDir || getHomeDir(env);
  const reader = createLineReader(stdin, stdout);

  function writeOut(text) {
    if (stdout && typeof stdout.write === 'function') {
      stdout.write(text);
    }
  }

  function writeErr(text) {
    if (stderr && typeof stderr.write === 'function') {
      stderr.write(text);
    }
  }

  try {
    // Warn once at the start if a credential env var is set
    const activeCreds = getActiveCredentialEnvVars(env);
    if (activeCreds.length > 0) {
      writeOut(
        `Warning: Credential env var(s) set (${activeCreds.join(', ')}). They will be removed when spawning CLI logins.\n`
      );
    }

    let pendingServiceChoice = initialService;

    while (true) {
      let rawChoice;
      if (pendingServiceChoice !== null && pendingServiceChoice !== undefined && String(pendingServiceChoice).trim() !== '') {
        rawChoice = String(pendingServiceChoice).trim();
        pendingServiceChoice = null;
      } else {
        printServiceMenu(writeOut);
        rawChoice = await reader.question('Choose a service (1-16, name, or "done"): ');
      }

      if (rawChoice === null) {
        // End of input
        break;
      }

      const choiceTrimmed = rawChoice.trim();
      if (!choiceTrimmed) {
        continue;
      }

      if (END_LOOP_WORDS.has(choiceTrimmed.toLowerCase())) {
        break;
      }

      let svc = getService(choiceTrimmed);
      if (!svc) {
        writeOut(`Invalid choice "${choiceTrimmed}". Please enter 1-16, a service name, or "done".\n`);
        continue;
      }

      // Handle custom service (16 / custom)
      if (svc.isCustom) {
        const rawSvcName = await reader.question('Service name (e.g. myprovider): ');
        if (rawSvcName === null) break;
        if (!rawSvcName.trim() || isCancelWord(rawSvcName)) {
          writeOut('Cancelled.\n');
          continue;
        }
        let customServiceId;
        try {
          customServiceId = sanitizeName(rawSvcName, 'service name').toLowerCase();
        } catch (err) {
          writeOut(`${err.message}\n`);
          continue;
        }

        const rawAccName = await reader.question('Account name (e.g. personal, work): ');
        if (rawAccName === null) break;
        if (!rawAccName.trim() || isCancelWord(rawAccName)) {
          writeOut('Cancelled.\n');
          continue;
        }
        let accName;
        try {
          accName = sanitizeName(rawAccName, 'account name');
        } catch (err) {
          writeOut(`${err.message}\n`);
          continue;
        }

        if (getAccount(customServiceId, accName, resolvedHome)) {
          writeOut(`Account "${accName}" already exists for "${customServiceId}".\n`);
          continue;
        }

        const defaultEnvName = `${customServiceId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
        const rawEnvName = await reader.question(`Environment variable name [${defaultEnvName}]: `);
        if (rawEnvName === null) break;
        const envName = rawEnvName.trim() || defaultEnvName;

        const rawEndpoint = await reader.question('Endpoint URL: ');
        if (rawEndpoint === null) break;
        if (!rawEndpoint.trim() || isCancelWord(rawEndpoint)) {
          writeOut('Cancelled.\n');
          continue;
        }
        const endpoint = rawEndpoint.trim();

        const rawModel = await reader.question('Default model: ');
        if (rawModel === null) break;
        if (!rawModel.trim() || isCancelWord(rawModel)) {
          writeOut('Cancelled.\n');
          continue;
        }
        const model = rawModel.trim();

        const rawKey = await reader.readSecret('API key: ');
        if (rawKey === null) break;
        if (!rawKey.trim() || isCancelWord(rawKey)) {
          writeOut('Cancelled (no API key entered).\n');
          continue;
        }

        const rawId = await reader.question('Email or ID of this account (optional): ');
        const accountId = rawId ? rawId.trim() : '';

        addAccount(
          {
            service: customServiceId,
            name: accName,
            id: accountId,
            kind: 'apikey',
            env: envName,
            endpoint,
            model,
            key: rawKey.trim(),
          },
          resolvedHome
        );
        writeOut(`Saved ${customServiceId}:${accName}.\n`);
        continue;
      }

      // Standard service (1-15): prompt for account name
      const rawName = await reader.question(`Account name for ${svc.id} (e.g. personal, work): `);
      if (rawName === null) {
        break;
      }
      if (!rawName.trim() || isCancelWord(rawName)) {
        writeOut('Cancelled.\n');
        continue;
      }

      let accName;
      try {
        accName = sanitizeName(rawName, 'account name');
      } catch (err) {
        writeOut(`${err.message}\n`);
        continue;
      }

      if (getAccount(svc.id, accName, resolvedHome)) {
        writeOut(`Account "${accName}" already exists for "${svc.id}".\n`);
        continue;
      }

      if (svc.kind === 'login') {
        const binPath = resolveBinary(svc.bin, env, platform);
        if (!binPath) {
          writeOut(`Binary "${svc.bin}" is not installed or not on PATH.\n`);
          continue;
        }

        const rawId = await reader.question('Email or ID of this account (optional): ');
        const accountId = rawId ? rawId.trim() : '';

        let loginArgs = [];
        if (svc.id === 'claude') {
          loginArgs = ['auth', 'login'];
          if (accountId.includes('@')) {
            loginArgs.push('--email', accountId);
          }
        } else if (svc.supportsDeviceAuth) {
          const rawRemote = await reader.question(
            'remote or headless machine with no browser? [y/N]: '
          );
          if (rawRemote === null) break;
          const useDevice = /^(y|yes)$/i.test(rawRemote.trim());
          loginArgs = useDevice ? ['login', '--device-auth'] : ['login'];
        } else {
          loginArgs = ['login'];
        }

        const profileDir = getProfileDir(svc.id, accName, resolvedHome);
        const existedBefore = fs.existsSync(profileDir);
        ensureDir(profileDir, 0o700);

        const tempAccount = {
          service: svc.id,
          name: accName,
          id: accountId,
          kind: 'login',
          location: profileDir,
          env: svc.envDir,
        };

        const childStdio = stdin && stdin.isTTY ? 'inherit' : ['ignore', 'pipe', 'pipe'];
        try {
          await spawnInteractiveCli({
            service: svc,
            account: tempAccount,
            args: loginArgs,
            env,
            stdio: childStdio,
            platform,
          });
        } catch (err) {
          writeErr(`Failed to launch ${svc.bin}: ${err.message}\n`);
        }

        const passed = await checkLoginStatus({
          service: svc,
          account: tempAccount,
          env,
          platform,
        });

        if (!passed) {
          if (!existedBefore && fs.existsSync(profileDir)) {
            try {
              fs.rmSync(profileDir, { recursive: true, force: true });
            } catch (_) {}
          }
          writeOut(`Sign-in verification failed for ${svc.id}:${accName}. Not saved.\n`);
          continue;
        }

        addAccount(
          {
            service: svc.id,
            name: accName,
            id: accountId,
            kind: 'login',
            location: profileDir,
            env: svc.envDir,
          },
          resolvedHome
        );
        writeOut(`Saved ${svc.id}:${accName}.\n`);
        continue;
      }

      if (svc.kind === 'firstrun') {
        const binPath = resolveBinary(svc.bin, env, platform);
        if (!binPath) {
          writeOut(`Binary "${svc.bin}" is not installed or not on PATH.\n`);
          continue;
        }

        writeOut(
          `Note: ${svc.id} (${svc.bin}) signs in when you run the tool; we do not verify it automatically.\n`
        );
        const rawConfirm = await reader.question(
          'Press Enter (or y/yes/signed) to record this account, or anything else to skip: '
        );
        if (rawConfirm === null) break;
        const conf = rawConfirm.trim().toLowerCase();
        if (!['', 'y', 'yes', 'signed'].includes(conf)) {
          writeOut(`Skipped ${svc.id}:${accName}.\n`);
          continue;
        }

        const rawId = await reader.question('Email or ID of this account (optional): ');
        const accountId = rawId ? rawId.trim() : '';

        addAccount(
          {
            service: svc.id,
            name: accName,
            id: accountId,
            kind: 'firstrun',
          },
          resolvedHome
        );
        writeOut(`Saved ${svc.id}:${accName}.\n`);
        continue;
      }

      if (svc.kind === 'apikey') {
        if (svc.keyPage) {
          writeOut(`Get your API key at: ${svc.keyPage}\n`);
        }
        const rawKey = await reader.readSecret('API key: ');
        if (rawKey === null) break;
        const cleanKey = rawKey.trim();
        if (!cleanKey || isCancelWord(cleanKey)) {
          writeOut('Cancelled (no API key provided).\n');
          continue;
        }

        const rawId = await reader.question('Email or ID of this account (optional): ');
        const accountId = rawId ? rawId.trim() : '';

        addAccount(
          {
            service: svc.id,
            name: accName,
            id: accountId,
            kind: 'apikey',
            key: cleanKey,
          },
          resolvedHome
        );
        writeOut(`Saved ${svc.id}:${accName}.\n`);
        continue;
      }
    }

    return 0;
  } finally {
    reader.close();
  }
}

module.exports = {
  END_LOOP_WORDS,
  runAddLoop,
};
