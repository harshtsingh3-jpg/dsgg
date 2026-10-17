// ============================================================
// LLM Client — talks to the ACTIVE provider via OpenAI-compatible
// /chat/completions. Works with NVIDIA NIM, OpenRouter, Ollama,
// OpenAI, Groq or any custom base URL the user enters.
// Includes JSON-mode parsing with robust recovery.
// ============================================================
import { getActiveConfig } from './registry.js';

export async function chat({ messages, temperature = 0.3, maxTokens = 1600, json = false, configOverride } = {}) {
  const cfg = configOverride || getActiveConfig();
  if (!cfg.baseUrl) throw new Error('No provider configured');

  const body = {
    model: cfg.model,
    messages,
    temperature,
    max_tokens: maxTokens
  };
  if (json) {
    // Most OpenAI-compatible servers accept response_format; Ollama too.
    body.response_format = { type: 'json_object' };
  }

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Provider "${cfg.name}" HTTP ${res.status}: ${txt.slice(0, 400)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  return { content, usage: data.usage || null, provider: cfg.name, model: cfg.model };
}

/** Extract a JSON object from an LLM reply even if wrapped in prose/fences. */
export function parseJsonLoose(text) {
  if (!text) throw new Error('Empty LLM response');
  // strip code fences
  let t = text.replace(/```(json)?/gi, '').trim();
  // direct parse
  try { return JSON.parse(t); } catch {}
  // find first balanced { ... }
  const start = t.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in model reply');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = t.slice(start, i + 1);
          try { return JSON.parse(candidate); } catch { break; }
        }
      }
    }
  }
  // last resort: repair common issues (trailing commas)
  const cleaned = t.slice(start).replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(cleaned); } catch {}
  throw new Error('Could not parse JSON from model reply');
}

export async function chatJson(args) {
  const r = await chat({ ...args, json: true });
  try {
    return { ...r, json: parseJsonLoose(r.content) };
  } catch (e) {
    // one retry asking explicitly for pure JSON
    const retry = await chat({
      ...args,
      json: true,
      messages: [
        ...args.messages,
        { role: 'assistant', content: r.content },
        { role: 'user', content: 'Your previous reply was not valid JSON. Reply again with ONLY a valid JSON object, no prose, no markdown fences.' }
      ]
    });
    return { ...retry, json: parseJsonLoose(retry.content) };
  }
}
