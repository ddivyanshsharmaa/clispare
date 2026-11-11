'use strict';

// Classifies real CLI output captured on 2026-11-11 (fixtures/real/<engine>-<case>.txt) and the
// literal limit/auth strings grepped out of each installed CLI (fixtures/real/strings-<engine>.txt).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const classify = require('../src/classify');

const DIR = path.join(__dirname, '..', 'fixtures', 'real');
const HOUR = 3600 * 1000;

function readCapture(name) {
  const text = fs.readFileSync(path.join(DIR, `${name}.txt`), 'utf8').replace(/\r\n/g, '\n');
  const exit = Number(/^# exit: (\d+)$/m.exec(text)[1]);
  const outStart = text.indexOf('--- stdout ---\n') + '--- stdout ---\n'.length;
  const errMarker = text.indexOf('\n--- stderr ---\n');
  return {
    exitCode: exit,
    stdout: text.slice(outStart, errMarker),
    stderr: text.slice(errMarker + '\n--- stderr ---\n'.length),
  };
}

const expected = {
  'claude-badflag': 'fatal',
  'claude-badmodel': 'fatal',
  'claude-loggedout': 'auth',
  'claude-badkey': 'auth',
  'codex-badflag': 'fatal',
  'codex-badmodel': 'fatal',
  'codex-loggedout': 'auth',
  'codex-badkey': 'auth',
  'gemini-badflag': 'fatal',
  'gemini-loggedout': 'auth',
  'gemini-badkey': 'auth',
  'gemini-badmodel': 'auth',
  'agy-badflag': 'fatal',
  'agy-badmodel': 'fatal',
  'agy-quota-exhausted': 'limit',
  'grok-badflag': 'fatal',
  'grok-badmodel': 'fatal',
  'grok-loggedout': 'auth',
  'grok-badkey': 'auth',
};

test('every captured fixture has an expected class', () => {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.txt') && !f.startsWith('strings-'))
    .map((f) => f.slice(0, -4))
    .sort();
  assert.deepEqual(files, Object.keys(expected).sort());
});

for (const [name, cls] of Object.entries(expected)) {
  test(`real output ${name} classifies as ${cls}`, () => {
    const res = classify({ ...readCapture(name), now: Date.UTC(2026, 10, 11, 12) });
    assert.equal(res.category, cls);
  });
}

test('agy quota message parses the compact "Resets in 64h40m29s" reset', () => {
  const res = classify({ ...readCapture('agy-quota-exhausted'), now: Date.UTC(2026, 10, 11, 12) });
  assert.equal(res.cooldownMs, (64 * 3600 + 40 * 60 + 29) * 1000);
  assert.equal(res.resetParsed, true);
});

for (const engine of ['claude', 'codex', 'gemini', 'agy', 'grok']) {
  test(`literal ${engine} strings classify as labelled`, () => {
    const lines = fs
      .readFileSync(path.join(DIR, `strings-${engine}.txt`), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#'));
    assert.ok(lines.length > 0);
    for (const line of lines) {
      const [cls, str] = line.split('\t');
      const res = classify({ exitCode: 1, stdout: '', stderr: str, now: Date.UTC(2026, 10, 11, 12) });
      assert.equal(res.category, cls, `${engine}: ${str}`);
    }
  });
}

test('Claude reset suffixes parse from local clock and date forms', () => {
  const now = new Date(2026, 10, 11, 12, 0, 0, 0).getTime(); // noon local

  const today = classify({ exitCode: 1, stderr: "You've hit your session limit · resets 3pm (Asia/Calcutta)", now });
  assert.equal(today.category, 'limit');
  assert.equal(today.cooldownMs, 3 * HOUR);

  const half = classify({ exitCode: 1, stderr: "You've hit your Opus limit · resets 3:30pm (Asia/Calcutta)", now });
  assert.equal(half.cooldownMs, 3.5 * HOUR);

  const dated = classify({ exitCode: 1, stderr: "You've hit your weekly limit · resets Nov 14, 3pm (Asia/Calcutta)", now });
  assert.equal(dated.cooldownMs, new Date(2026, 10, 14, 15, 0, 0, 0).getTime() - now);

  const epoch = classify({ exitCode: 1, stderr: `Claude AI usage limit reached|${Math.floor(now / 1000) + 7200}`, now });
  assert.equal(epoch.cooldownMs, 2 * HOUR);
});

test('Codex "try again at" with a full date parses that date', () => {
  const now = new Date(2026, 10, 11, 12, 0, 0, 0).getTime();
  const res = classify({
    exitCode: 0,
    stdout: '',
    stderr: "ERROR: You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 12th, 2026 3:05 PM.",
    now,
  });
  assert.equal(res.category, 'limit');
  assert.equal(res.cooldownMs, new Date(2026, 10, 12, 15, 5, 0, 0).getTime() - now);
});

test('a bare number after "resets" is not taken as a clock time', () => {
  const now = new Date(2026, 10, 11, 12, 0, 0, 0).getTime();
  const res = classify({ exitCode: 1, stderr: 'Usage limit reached. It resets 5 days from now.', now });
  assert.equal(res.category, 'limit');
  assert.equal(res.cooldownMs, 5 * HOUR); // default, nothing parsed
  assert.equal(res.resetParsed, false);
});
