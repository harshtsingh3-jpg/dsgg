// ============================================================
// Provider Registry — connect ANY OpenAI-compatible LLM provider
// Built-in presets: NVIDIA NIM, OpenRouter, Ollama, plus free-form
// custom providers (name + base URL + model + API key).
// ============================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');

// ---- Built-in presets (user can override keys/urls in UI) ----
export const BUILTIN_PRESETS = [
  {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: [
      'meta/llama-3.1-70b-instruct',
      'meta/llama-3.1-8b-instruct',
      'mistralai/mixtral-8x22b-instruct-v0.1',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'microsoft/phi-4',
      'deepseek-ai/deepseek-r1'
    ],
    defaultModel: 'meta/llama-3.1-70b-instruct',
    needsKey: true,
    docs: 'Get an API key at build.nvidia.com (each model page → "Get API Key")'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'openai/gpt-4o-mini',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-flash-1.5',
      'meta-llama/llama-3.1-70b-instruct',
      'deepseek/deepseek-chat',
      'mistralai/mistral-large'
    ],
    defaultModel: 'openai/gpt-4o-mini',
    needsKey: true,
    docs: 'Get a key at openrouter.ai/keys — one key, hundreds of models'
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    models: [
      'llama3.1',
      'qwen2.5',
      'mistral',
      'gemma2',
      'phi4',
      'deepseek-r1'
    ],
    defaultModel: 'llama3.1',
    needsKey: false,
    apiKeyHint: 'not required',
    docs: 'Run `ollama serve` locally and `ollama pull llama3.1`. No key needed.'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
    defaultModel: 'gpt-4o-mini',
    needsKey: true,
    docs: 'Standard OpenAI API'
  },
  {
    id: 'groq',
    name: 'Groq (ultra-fast)',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    defaultModel: 'llama-3.3-70b-versatile',
    needsKey: true,
    docs: 'Free tier keys at console.groq.com — very fast inference'
  }
];

let state = load();

function load() {
  try {
    const raw = fs.readFileSync(PROVIDERS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      providers: [],            // user-added custom providers
      activeProviderId: 'ollama',
      activeModel: null         // falls back to preset default
    };
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(state, null, 2));
}

// ---------- Public API ----------

export function listProviders() {
  const custom = state.providers.map(p => ({ ...p, builtin: false }));
  const presets = BUILTIN_PRESETS.map(p => ({ ...p, builtin: true }));
  return [...presets, ...custom];
}

export function getProvider(id) {
  return listProviders().find(p => p.id === id) || null;
}

/** Add a fully custom provider: any name, base url, model, api key. */
export function addCustomProvider({ name, baseUrl, model, apiKey, location }) {
  const id = 'custom-' + Math.random().toString(36).slice(2, 8);
  const provider = {
    id,
    name: name || 'Custom Provider',
    baseUrl: (baseUrl || '').replace(/\/+$/, ''),
    models: model ? [model] : [],
    defaultModel: model || '',
    apiKey: apiKey || '',
    needsKey: !!apiKey,
    builtin: false,
    location: location || 'global',
    docs: 'User-defined custom OpenAI-compatible endpoint'
  };
  if (!provider.baseUrl) throw new Error('Base URL is required');
  state.providers.push(provider);
  save();
  return provider;
}

export function updateProvider(id, patch) {
  const idx = state.providers.findIndex(p => p.id === id);
  if (idx >= 0) {
    state.providers[idx] = { ...state.providers[idx], ...patch };
    save();
    return state.providers[idx];
  }
  // Built-in preset overrides are stored as an overlay entry
  const preset = BUILTIN_PRESETS.find(p => p.id === id);
  if (preset) {
    const existing = state.providers.find(p => p.id === id);
    if (existing) {
      state.providers[idx < 0 ? state.providers.findIndex(p => p.id === id) : idx] = { ...existing, ...patch };
    } else {
      state.providers.push({ ...preset, ...patch, builtin: true, overridden: true });
    }
    save();
    return state.providers[state.providers.length - 1];
  }
  return null;
}

export function removeProvider(id) {
  state.providers = state.providers.filter(p => p.id !== id);
  save();
}

export function setActive(idOrName, model) {
  state.activeProviderId = idOrName;
  state.activeModel = model || null;
  save();
}

export function getActiveConfig() {
  const prov = getProvider(state.activeProviderId) || getProvider('ollama') || BUILTIN_PRESETS[0];
  const model = state.activeModel || prov.defaultModel || (prov.models && prov.models[0]) || 'llama3.1';
  return {
    id: prov.id,
    name: prov.name,
    baseUrl: (prov.baseUrl || '').replace(/\/+$/, ''),
    model,
    apiKey: prov.apiKey || process.env.OPENAI_API_KEY || ''
  };
}

export function getState() {
  return {
    activeProviderId: state.activeProviderId,
    activeModel: state.activeModel,
    providers: listProviders().map(stripSecrets)
  };
}

function stripSecrets(p) {
  return { ...p, apiKey: p.apiKey ? '••••' + String(p.apiKey).slice(-4) : '' };
}

/**
 * Test connectivity by issuing a tiny chat completion against the provider.
 */
export async function testProvider({ baseUrl, model, apiKey }) {
  const t0 = Date.now();
  const res = await fetch(`${(baseUrl || '').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model: model || 'default',
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 5,
      temperature: 0
    }),
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  return { ok: true, ms: Date.now() - t0, reply: json?.choices?.[0]?.message?.content ?? '' };
}
