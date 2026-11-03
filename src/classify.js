'use strict';

// NOTE: These CLI message patterns are NOT verified against real provider output yet
// and are expected to need tuning as providers update their CLI output formats.
const limit =
  /usage limit|rate.?limit|limit (reached|exceeded)|quota|too many requests|try again (in|after)|resets? (at|in)|credit|insufficient|out of (credits|tokens)|\b429\b|\b402\b/i;
const auth =
  /not (logged|signed) in|log ?in|sign ?in|unauthori[sz]ed|authenticat|invalid (api )?key|\b401\b|\b403\b|expired token/i;
const transient =
  /overload|temporar|unavailable|timed? ?out|ETIMEDOUT|ECONN|ENOTFOUND|socket hang|\b50[0-4]\b|bad gateway/i;

const RELATIVE_RESET_RE =
  /(?:try again (?:in|after)|retry after|resets? in|\bin)\s+(?:(\d+)\s*(?:hours?|hrs?|h)\b)?[\s,]*(?:(\d+)\s*(?:minutes?|mins?|m)\b)?[\s,]*(?:(\d+)\s*(?:seconds?|secs?|s)\b)?/i;
const CLOCK_RESET_RE =
  /(?:resets?|try again|available)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const SIXTY_SECONDS_MS = 60 * 1000;

function classify(input, secondArg, thirdArg) {
  let status = null;
  let exitCode = null;
  let stdout = '';
  let stderr = '';
  let retryAfter = null;
  let timedOut = false;
  let now = Date.now();

  if (typeof input === 'string') {
    exitCode = 1;
    stderr = input;
    if (typeof secondArg === 'number') {
      now = secondArg;
    }
  } else if (typeof input === 'number') {
    if (input >= 100 && thirdArg === undefined && typeof secondArg !== 'string') {
      status = input;
    } else {
      exitCode = input;
      stdout = typeof secondArg === 'string' ? secondArg : '';
      stderr = typeof thirdArg === 'string' ? thirdArg : '';
    }
  } else if (input && typeof input === 'object') {
    if (typeof input.now === 'number') now = input.now;
    else if (typeof secondArg === 'number') now = secondArg;

    if (typeof input.status === 'number') status = input.status;
    else if (typeof input.statusCode === 'number') status = input.statusCode;

    if (typeof input.exitCode === 'number') exitCode = input.exitCode;
    else if (typeof input.code === 'number') exitCode = input.code;

    stdout = String(input.stdout ?? input.output ?? '');
    stderr = String(input.stderr ?? input.text ?? input.message ?? input.error ?? '');
    retryAfter = input.retryAfter ?? (input.headers && input.headers['retry-after']) ?? null;
    timedOut = Boolean(input.timedOut);
  }

  const combined = `${stdout}\n${stderr}`.trim();

  // Parse reset hints from text on a best-effort basis
  let parsedResetMs = null;
  if (combined) {
    const relMatch = RELATIVE_RESET_RE.exec(combined);
    if (relMatch && (relMatch[1] || relMatch[2] || relMatch[3])) {
      const h = Number(relMatch[1] || 0);
      const m = Number(relMatch[2] || 0);
      const s = Number(relMatch[3] || 0);
      const totalMs = (h * 3600 + m * 60 + s) * 1000;
      if (totalMs > 0) {
        parsedResetMs = totalMs;
      }
    }
    if (parsedResetMs === null) {
      const clockMatch = CLOCK_RESET_RE.exec(combined);
      if (clockMatch) {
        let hour = Number(clockMatch[1]);
        const minute = Number(clockMatch[2] || 0);
        const ampm = (clockMatch[3] || '').toLowerCase();
        if (ampm === 'pm' && hour < 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;
        if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
          const target = new Date(now);
          target.setHours(hour, minute, 0, 0);
          if (target.getTime() <= now) {
            target.setDate(target.getDate() + 1);
          }
          parsedResetMs = target.getTime() - now;
        }
      }
    }
  }

  // Parse Retry-After header if present
  let retryAfterMs = null;
  if (retryAfter !== null && retryAfter !== undefined && String(retryAfter).trim() !== '') {
    const rawRetry = String(retryAfter).trim();
    if (/^\d+(\.\d+)?$/.test(rawRetry)) {
      const secs = Number(rawRetry);
      if (secs > 0) retryAfterMs = Math.ceil(secs * 1000);
    } else {
      const parsedDate = Date.parse(rawRetry);
      if (!Number.isNaN(parsedDate) && parsedDate > now) {
        retryAfterMs = parsedDate - now;
      }
    }
  }

  let category = 'fatal';
  let cooldownMs = 0;

  // 1. HTTP adapter decides by status code first
  if (typeof status === 'number') {
    if (status >= 200 && status < 300) {
      category = 'ok';
      cooldownMs = 0;
    } else if (status === 429) {
      category = 'limit';
      cooldownMs = retryAfterMs ?? parsedResetMs ?? SIXTY_SECONDS_MS;
    } else if (status === 402) {
      category = 'limit';
      cooldownMs = parsedResetMs ?? TWENTY_FOUR_HOURS_MS;
    } else if (status === 401 || status === 403) {
      category = 'auth';
      cooldownMs = TEN_MINUTES_MS;
    } else if (status >= 500 && status <= 599) {
      category = 'transient';
      cooldownMs = FIVE_MINUTES_MS;
    } else if (status >= 400 && status <= 499) {
      category = 'fatal';
      cooldownMs = 0;
    } else {
      category = 'fatal';
      cooldownMs = 0;
    }
  } else if (timedOut) {
    category = 'transient';
    cooldownMs = FIVE_MINUTES_MS;
  } else if (exitCode === 0 && stdout.trim().length > 0) {
    // CLI adapter rule: exit 0 with non-empty output is ok even if the text mentions a limit
    category = 'ok';
    cooldownMs = 0;
  } else if (exitCode === 0 && combined.length === 0) {
    category = 'ok';
    cooldownMs = 0;
  } else {
    if (limit.test(combined)) {
      category = 'limit';
      cooldownMs = parsedResetMs ?? FIVE_HOURS_MS;
    } else if (auth.test(combined)) {
      category = 'auth';
      cooldownMs = TEN_MINUTES_MS;
    } else if (transient.test(combined)) {
      category = 'transient';
      cooldownMs = FIVE_MINUTES_MS;
    } else {
      category = 'fatal';
      cooldownMs = 0;
    }
  }

  return {
    category,
    class: category,
    kind: category,
    type: category,
    cooldownMs,
    until: cooldownMs > 0 ? now + cooldownMs : null,
    resetParsed: parsedResetMs !== null || retryAfterMs !== null,
  };
}

classify.classify = classify;
classify.limit = limit;
classify.auth = auth;
classify.transient = transient;
classify.LIMIT_RE = limit;
classify.AUTH_RE = auth;
classify.TRANSIENT_RE = transient;

module.exports = classify;
