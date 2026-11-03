#!/usr/bin/env node
'use strict';

const { runCli } = require('../src/cli');

Promise.resolve(runCli(process.argv.slice(2)))
  .then((code) => {
    if (typeof code === 'number') {
      process.exitCode = code;
    }
  })
  .catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`[clispare] Error: ${msg}\n`);
    process.exitCode = 1;
  });
