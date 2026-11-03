'use strict';

const { resolveEndpoint, resolveModel } = require('../services');
const { readKeyFile } = require('../registry');
const { getHomeDir } = require('../util');

const DEFAULT_HTTP_TIMEOUT_MS = 60 * 1000;

function redactSecret(text, secret) {
  if (!text) return '';
  let str = String(text);
  if (secret && typeof secret === 'string' && secret.trim().length > 0) {
    const trimmed = secret.trim();
    str = str.split(trimmed).join('[REDACTED]');
    if (secret !== trimmed) {
      str = str.split(secret).join('[REDACTED]');
    }
  }
  return str;
}

async function runHttpCompletion({
  service,
  account,
  prompt,
  apiKey = null,
  homeDir = null,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  env = process.env,
  endpoint: customEndpoint = null,
  model: customModel = null,
}) {
  const serviceId =
    typeof service === 'string'
      ? service
      : (service && service.id) || (account && account.service) || '';
  const resolvedHome = homeDir || getHomeDir(env);
  const key =
    apiKey ||
    (account ? readKeyFile(account.service || serviceId, account.name, resolvedHome) : null);

  if (!key || !String(key).trim()) {
    return {
      ok: false,
      skipped: true,
      reason: 'without a key',
      status: null,
      stdout: '',
      output: '',
      stderr: `Missing API key for ${serviceId}`,
      retryAfter: null,
      timedOut: false,
    };
  }

  const cleanKey = String(key).trim();
  const endpoint = customEndpoint || resolveEndpoint(serviceId, account, env);
  const model = customModel || resolveModel(serviceId, account, env);

  if (!endpoint) {
    return {
      ok: false,
      status: 400,
      stdout: '',
      output: '',
      stderr: `No endpoint configured for service "${serviceId}"`,
      retryAfter: null,
      timedOut: false,
    };
  }

  const effectiveTimeout =
    typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_HTTP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, effectiveTimeout);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cleanKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: String(prompt ?? '') }],
      }),
      signal: controller.signal,
    });

    const status = response.status;
    const retryAfter = response.headers ? response.headers.get('retry-after') : null;
    const rawBody = await response.text();
    const safeBody = redactSecret(rawBody, cleanKey);

    if (status >= 200 && status < 300) {
      let data;
      try {
        data = JSON.parse(rawBody);
      } catch (_) {
        return {
          ok: false,
          status: 502,
          stdout: '',
          output: '',
          stderr: 'Invalid JSON response from provider',
          retryAfter,
          timedOut: false,
        };
      }
      const content =
        data &&
        Array.isArray(data.choices) &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content;

      if (typeof content !== 'string') {
        return {
          ok: false,
          status: 502,
          stdout: '',
          output: '',
          stderr: 'Missing choices[0].message.content in provider response',
          retryAfter,
          timedOut: false,
        };
      }

      const safeContent = redactSecret(content, cleanKey);
      return {
        ok: true,
        status,
        stdout: safeContent,
        output: safeContent,
        stderr: '',
        retryAfter,
        timedOut: false,
      };
    }

    let errMessage = safeBody;
    try {
      const parsedErr = JSON.parse(safeBody);
      if (parsedErr && parsedErr.error) {
        if (typeof parsedErr.error === 'string') {
          errMessage = parsedErr.error;
        } else if (typeof parsedErr.error.message === 'string') {
          errMessage = parsedErr.error.message;
        }
      }
    } catch (_) {}

    return {
      ok: false,
      status,
      stdout: '',
      output: '',
      stderr: redactSecret(`HTTP ${status}: ${errMessage}`, cleanKey),
      retryAfter,
      timedOut: false,
    };
  } catch (err) {
    const isAbort =
      (err && err.name === 'AbortError') ||
      (err && typeof err.message === 'string' && /abort|timed? ?out/i.test(err.message));
    const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
    const rawMsg = `${err && err.message ? err.message : String(err)} ${code}`.trim();
    const safeMsg = redactSecret(rawMsg, cleanKey);

    return {
      ok: false,
      status: null,
      stdout: '',
      output: '',
      stderr: isAbort ? `Request timed out (ETIMEDOUT): ${safeMsg}` : `Network error (ECONN): ${safeMsg}`,
      retryAfter: null,
      timedOut: isAbort,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_HTTP_TIMEOUT_MS,
  redactSecret,
  runHttpCompletion,
};
