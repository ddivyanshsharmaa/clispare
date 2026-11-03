'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const classify = require('../src/classify');

test('classify() covers all classes for CLI outputs', () => {
  const now = 1700000000000;

  // ok
  const okRes = classify({ exitCode: 0, stdout: 'Hello world\n', stderr: '', now });
  assert.equal(okRes.category, 'ok');
  assert.equal(okRes.cooldownMs, 0);

  // exit 0 with limit text in stdout is still ok
  const okWithLimitText = classify({
    exitCode: 0,
    stdout: 'Note: usage limit may apply when quota is exceeded, but here is your answer.',
    stderr: 'rate limit warning',
    now,
  });
  assert.equal(okWithLimitText.category, 'ok');
  assert.equal(okWithLimitText.cooldownMs, 0);

  // limit (default 5h for CLI)
  const limitRes = classify({
    exitCode: 1,
    stdout: '',
    stderr: 'Error: Claude AI usage limit reached.',
    now,
  });
  assert.equal(limitRes.category, 'limit');
  assert.equal(limitRes.cooldownMs, 5 * 60 * 60 * 1000);

  // auth (10m cooldown)
  const authRes = classify({
    exitCode: 1,
    stdout: '',
    stderr: 'Error: You are not logged in. Please run login first.',
    now,
  });
  assert.equal(authRes.category, 'auth');
  assert.equal(authRes.cooldownMs, 10 * 60 * 1000);

  // transient (5m cooldown)
  const transRes = classify({
    exitCode: 1,
    stdout: '',
    stderr: 'Server overloaded, temporarily unavailable (ETIMEDOUT)',
    now,
  });
  assert.equal(transRes.category, 'transient');
  assert.equal(transRes.cooldownMs, 5 * 60 * 1000);

  // fatal (0 cooldown)
  const fatalRes = classify({
    exitCode: 1,
    stdout: '',
    stderr: 'SyntaxError: Unexpected token in prompt file',
    now,
  });
  assert.equal(fatalRes.category, 'fatal');
  assert.equal(fatalRes.cooldownMs, 0);
});

test('classify() parses reset hints from CLI and HTTP error text', () => {
  const baseDate = new Date(2026, 10, 3, 18, 0, 0, 0); // 18:00 local time
  const now = baseDate.getTime();

  // "in 3h 20m"
  const rel1 = classify({
    exitCode: 1,
    stderr: 'Rate limit exceeded. Try again in 3h 20m.',
    now,
  });
  assert.equal(rel1.category, 'limit');
  assert.equal(rel1.cooldownMs, (3 * 3600 + 20 * 60) * 1000);

  // "retry after 120 seconds"
  const rel2 = classify({
    exitCode: 1,
    stderr: 'Too many requests, retry after 120 seconds.',
    now,
  });
  assert.equal(rel2.category, 'limit');
  assert.equal(rel2.cooldownMs, 120 * 1000);

  // "resets at 7:45 PM" (from 6:00 PM -> 1h 45m = 6300s)
  const clock1 = classify({
    exitCode: 1,
    stderr: 'Usage limit reached. Your quota resets at 7:45 PM.',
    now,
  });
  assert.equal(clock1.category, 'limit');
  assert.equal(clock1.cooldownMs, (1 * 3600 + 45 * 60) * 1000);
});

test('classify() decides by HTTP status code first', () => {
  const now = 1700000000000;

  assert.equal(classify({ status: 200, stdout: 'answer', now }).category, 'ok');

  const r429Default = classify({ status: 429, stderr: 'Too many requests', now });
  assert.equal(r429Default.category, 'limit');
  assert.equal(r429Default.cooldownMs, 60 * 1000);

  const r429Header = classify({
    status: 429,
    retryAfter: '180',
    stderr: 'Too many requests',
    now,
  });
  assert.equal(r429Header.category, 'limit');
  assert.equal(r429Header.cooldownMs, 180 * 1000);

  const r402 = classify({ status: 402, stderr: 'Out of credits', now });
  assert.equal(r402.category, 'limit');
  assert.equal(r402.cooldownMs, 24 * 60 * 60 * 1000);

  const r401 = classify({ status: 401, stderr: 'Invalid API key', now });
  assert.equal(r401.category, 'auth');
  assert.equal(r401.cooldownMs, 10 * 60 * 1000);

  const r403 = classify({ status: 403, stderr: 'Forbidden', now });
  assert.equal(r403.category, 'auth');

  const r503 = classify({ status: 503, stderr: 'Service unavailable', now });
  assert.equal(r503.category, 'transient');
  assert.equal(r503.cooldownMs, 5 * 60 * 1000);

  const r400 = classify({ status: 400, stderr: 'Bad request: unknown parameter', now });
  assert.equal(r400.category, 'fatal');
  assert.equal(r400.cooldownMs, 0);
});
