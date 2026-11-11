'use strict';

// Patterns are checked against real CLI output captured on 2026-11-11 (fixtures/real/*.txt)
// and against the literal strings in the installed claude, codex, gemini, agy and grok
// builds (fixtures/real/strings-*.txt). Bare words such as "quota", "credit", "limit reached"
// or "try again in" are avoided on purpose: the same builds print "Disk quota exceeded",
// "retry limit reached" and "Please try again in a moment" for problems that are not usage limits.
const limit = new RegExp(
  [
    'usage limit', // Usage limit reached / You've hit your usage limit / Claude AI usage limit reached
    'rate.?limit', // rate limit exceeded / Rate limited / rate_limit_error
    'hit (?:your|the) [^.\\n]{0,40}?(?:limit|cap|budget)', // hit your session limit / spend cap / team's shared budget
    'reached your [^.\\n]{0,40}?limit',
    '(?<!(?:dis[ck]|storage|agent-store) )quota (?:reached|exceeded|exhausted)',
    'exhausted your [^.\\n]{0,30}?quota',
    'quota_exceeded|insufficient_quota|resource_exhausted|usage_limit_reached|credits_depleted',
    'too many requests',
    'out of (?:extra )?(?:usage|credits|tokens)',
    'credit balance (?:is )?too low',
    'spend(?:ing)? (?:limit|cap)',
    'insufficient (?:credits|balance|funds|quota)',
    '(?:status|code|error|http)\\W{0,3}(?:429|402)\\b',
  ].join('|'),
  'i'
);
const auth = new RegExp(
  [
    'not (?:logged|signed) in', // Not logged in · Please run /login / Not signed in
    'log ?in',
    'sign ?in',
    'unauthori[sz]ed',
    'authenticat', // authentication required / Missing bearer or basic authentication
    'auth method', // gemini: Please set an Auth method
    'invalid (?:api )?key',
    'incorrect api key', // codex/OpenAI: Incorrect API key provided
    'key not valid|api_key_invalid|invalid_api_key', // gemini: API key not valid
    '(?:login|session|token) (?:has )?expired|expired token',
    'oauth token (?:expired|revoked)',
    '\\b401\\b',
    '\\b403\\b',
  ].join('|'),
  'i'
);
const transient =
  /overload|temporar|unavailable|timed? ?out|ETIMEDOUT|ECONN|ENOTFOUND|socket hang|\b50[0-4]\b|bad gateway|try again in a (?:moment|minute)/i;
// Bad flags and usage errors are always fatal, even when the printed help text mentions
// logins or limits (gemini and agy print their full option list on an unknown flag).
const usageError =
  /unknown (?:option|argument)|unexpected argument|flags? provided but not defined|^Usage(?::\s| of \S+:)/im;

const RELATIVE_RESET_RE =
  /(?:try again (?:in|after)|retry after|resets? in|\bin)\s+(?:(\d+)\s*(?:days?|d)(?![a-z]))?[\s,]*(?:(\d+)\s*(?:hours?|hrs?|h)(?![a-z]))?[\s,]*(?:(\d+)\s*(?:minutes?|mins?|m)(?![a-z]))?[\s,]*(?:(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)(?![a-z]))?/gi;
// "resets at 7:45 PM", "resets 3pm (Asia/Calcutta)", "resets Nov 14, 3pm", "try again at Nov 12th, 2026 3:05 PM"
const CLOCK_RESET_RE =
  /(?:resets?|try again|available)\s+(at\s+|on\s+)?(?:(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?)(?:,?\s+(\d{4}))?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?(?:\s*([ap])\.?m\.?)?(?![a-z0-9:])/i;
// Older Claude Code: "Claude AI usage limit reached|1731000000"
const EPOCH_RESET_RE = /limit reached\|(\d{10,13})\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function parseRelativeReset(text) {
  RELATIVE_RESET_RE.lastIndex = 0;
  let m;
  while ((m = RELATIVE_RESET_RE.exec(text)) !== null) {
    if (m[0].length === 0) {
      RELATIVE_RESET_RE.lastIndex += 1;
      continue;
    }
    if (m[1] || m[2] || m[3] || m[4]) {
      const totalMs =
        (Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60) * 1000 +
        Math.ceil(Number(m[4] || 0) * 1000);
      if (totalMs > 0) return totalMs;
    }
  }
  return null;
}

function parseClockReset(text, now) {
  const m = CLOCK_RESET_RE.exec(text);
  if (!m) return null;
  const [, at, monA, dayA, dayB, monB, year, hourStr, minuteStr, ampm] = m;
  const monName = (monA || monB || '').toLowerCase();
  // A bare number after "resets" needs am/pm, minutes, "at" or a date to count as a clock time
  if (!at && !minuteStr && !ampm && !monName) return null;
  let hour = Number(hourStr);
  const minute = Number(minuteStr || 0);
  const half = (ampm || '').toLowerCase();
  if (half && (hour < 1 || hour > 12)) return null;
  if (half === 'p' && hour < 12) hour += 12;
  if (half === 'a' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  const target = new Date(now);
  if (monName) {
    const month = MONTHS.indexOf(monName);
    if (month < 0) return null;
    const day = Number(dayA || dayB);
    target.setFullYear(year ? Number(year) : target.getFullYear(), month, day);
    target.setHours(hour, minute, 0, 0);
    if (!year && target.getTime() <= now) target.setFullYear(target.getFullYear() + 1);
  } else {
    target.setHours(hour, minute, 0, 0);
    if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  }
  const ms = target.getTime() - now;
  return ms > 0 ? ms : null;
}

function parseEpochReset(text, now) {
  const m = EPOCH_RESET_RE.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const at = m[1].length === 13 ? n : n * 1000;
  return at > now ? at - now : null;
}

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
    parsedResetMs =
      parseEpochReset(combined, now) ?? parseRelativeReset(combined) ?? parseClockReset(combined, now);
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
    if (usageError.test(combined)) {
      category = 'fatal';
      cooldownMs = 0;
    } else if (limit.test(combined)) {
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
classify.usageError = usageError;
classify.USAGE_ERROR_RE = usageError;

module.exports = classify;
