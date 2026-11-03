'use strict';

// Note: Endpoints and model names below are defaults that may go stale over time.
// They are overridable with env vars CLISPARE_BASE_<SERVICE> and CLISPARE_MODEL_<SERVICE>.

const SERVICES = [
  {
    id: 'claude',
    name: 'claude',
    kind: 'login',
    bin: 'claude',
    envDir: 'CLAUDE_CONFIG_DIR',
    loginCmd: 'claude auth login [--email X]',
    supportsEmail: true,
    supportsDeviceAuth: false,
    checkArgs: ['auth', 'status'],
    checkType: 'exit0',
    headless: { args: ['-p'], input: 'stdin' },
  },
  {
    id: 'codex',
    name: 'codex',
    kind: 'login',
    bin: 'codex',
    envDir: 'CODEX_HOME',
    loginCmd: 'codex login [--device-auth]',
    supportsEmail: false,
    supportsDeviceAuth: true,
    checkArgs: ['login', 'status'],
    checkType: 'codex-status',
    headless: { args: ['exec', '-'], input: 'stdin' },
  },
  {
    id: 'grok',
    name: 'grok',
    kind: 'login',
    bin: 'grok',
    envDir: 'GROK_HOME',
    loginCmd: 'grok login [--device-auth]',
    supportsEmail: false,
    supportsDeviceAuth: true,
    checkType: 'file',
    checkFile: 'auth.json',
    headless: { args: ['-p'], input: 'arg' },
  },
  {
    id: 'agy',
    name: 'agy',
    kind: 'firstrun',
    bin: 'agy',
    headless: { args: ['-p'], input: 'arg' },
  },
  {
    id: 'gemini',
    name: 'gemini',
    kind: 'firstrun',
    bin: 'gemini',
    headless: null,
  },
  {
    id: 'qwen',
    name: 'qwen',
    kind: 'firstrun',
    bin: 'qwen',
    headless: null,
  },
  {
    id: 'kimi',
    name: 'kimi',
    kind: 'firstrun',
    bin: 'kimi',
    headless: null,
  },
  {
    id: 'copilot',
    name: 'copilot',
    kind: 'firstrun',
    bin: 'copilot',
    headless: null,
  },
  {
    id: 'cursor',
    name: 'cursor',
    kind: 'firstrun',
    bin: 'agent',
    headless: null,
  },
  {
    id: 'deepseek',
    name: 'deepseek',
    kind: 'apikey',
    env: 'DEEPSEEK_API_KEY',
    keyPage: 'https://platform.deepseek.com/api_keys',
    endpoint: 'https://api.deepseek.com/chat/completions',
    defaultModel: 'deepseek-chat',
    model: 'deepseek-chat',
  },
  {
    id: 'openrouter',
    name: 'openrouter',
    kind: 'apikey',
    env: 'OPENROUTER_API_KEY',
    keyPage: 'https://openrouter.ai/settings/keys',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'openrouter/auto',
    model: 'openrouter/auto',
  },
  {
    id: 'groq',
    name: 'groq',
    kind: 'apikey',
    env: 'GROQ_API_KEY',
    keyPage: 'https://console.groq.com/keys',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
    model: 'llama-3.3-70b-versatile',
  },
  {
    id: 'mistral',
    name: 'mistral',
    kind: 'apikey',
    env: 'MISTRAL_API_KEY',
    keyPage: 'https://console.mistral.ai/api-keys/',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    defaultModel: 'mistral-small-latest',
    model: 'mistral-small-latest',
  },
  {
    id: 'zai',
    name: 'zai',
    kind: 'apikey',
    env: 'ZAI_API_KEY',
    keyPage: 'https://z.ai',
    endpoint: 'https://api.z.ai/api/paas/v4/chat/completions',
    defaultModel: 'glm-4.6',
    model: 'glm-4.6',
  },
  {
    id: 'together',
    name: 'together',
    kind: 'apikey',
    env: 'TOGETHER_API_KEY',
    keyPage: 'https://api.together.ai/settings/api-keys',
    endpoint: 'https://api.together.xyz/v1/chat/completions',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
];

const SERVICE_MAP = Object.fromEntries(SERVICES.map((s) => [s.id, s]));

const DEFAULT_CLI_ENGINES = ['claude', 'codex', 'agy', 'grok'];

function getService(idOrChoice, customAccount = null) {
  if (idOrChoice === undefined || idOrChoice === null) return null;
  const raw = String(idOrChoice).trim().toLowerCase();
  if (/^\d+$/.test(raw)) {
    const idx = Number(raw);
    if (idx >= 1 && idx <= SERVICES.length) {
      return SERVICES[idx - 1];
    }
    if (idx === 16) {
      return { id: 'custom', name: 'custom', kind: 'apikey', isCustom: true };
    }
    return null;
  }
  if (raw === 'custom' || raw === 'another' || raw === 'another service') {
    return { id: 'custom', name: 'custom', kind: 'apikey', isCustom: true };
  }
  if (SERVICE_MAP[raw]) {
    return SERVICE_MAP[raw];
  }
  if (customAccount && customAccount.kind === 'apikey') {
    return {
      id: customAccount.service || raw,
      name: customAccount.service || raw,
      kind: 'apikey',
      env: customAccount.env || `${raw.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`,
      endpoint: customAccount.endpoint || '',
      defaultModel: customAccount.model || '',
      model: customAccount.model || '',
      isCustom: true,
    };
  }
  return null;
}

function toEnvSuffix(serviceId) {
  return String(serviceId).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function resolveEndpoint(serviceId, account = null, env = process.env) {
  const suffix = toEnvSuffix(serviceId);
  const envKey = `CLISPARE_BASE_${suffix}`;
  if (env && env[envKey] && String(env[envKey]).trim()) {
    return String(env[envKey]).trim();
  }
  if (env && env.CLISPARE_BASE_CUSTOM && String(env.CLISPARE_BASE_CUSTOM).trim() && !SERVICE_MAP[serviceId]) {
    return String(env.CLISPARE_BASE_CUSTOM).trim();
  }
  if (account && account.endpoint && String(account.endpoint).trim()) {
    return String(account.endpoint).trim();
  }
  const svc = SERVICE_MAP[String(serviceId).toLowerCase()];
  return svc && svc.endpoint ? svc.endpoint : '';
}

function resolveModel(serviceId, account = null, env = process.env) {
  const suffix = toEnvSuffix(serviceId);
  const envKey = `CLISPARE_MODEL_${suffix}`;
  if (env && env[envKey] && String(env[envKey]).trim()) {
    return String(env[envKey]).trim();
  }
  if (env && env.CLISPARE_MODEL_CUSTOM && String(env.CLISPARE_MODEL_CUSTOM).trim() && !SERVICE_MAP[serviceId]) {
    return String(env.CLISPARE_MODEL_CUSTOM).trim();
  }
  if (account && account.model && String(account.model).trim()) {
    return String(account.model).trim();
  }
  const svc = SERVICE_MAP[String(serviceId).toLowerCase()];
  return svc && svc.defaultModel ? svc.defaultModel : '';
}

module.exports = {
  SERVICES,
  SERVICE_MAP,
  DEFAULT_CLI_ENGINES,
  getService,
  resolveEndpoint,
  resolveModel,
};
