// ============================================================
// Tool Registry — every capability the agent can execute.
// Each tool: { name, description, parameters, run(args, ctx) }
// ctx = { emit(eventFn), memory, task }
// ============================================================
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { chatJson, chat } from '../providers/llm.js';

const pexec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const WORKSPACE = process.env.AGENT_WORKSPACE || os.homedir();

// ---------------- safety helpers ----------------
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+\/(\s|$)/i,   // rm -rf /
  /\bmkfs\b/i, /\bdd\s+if=.*of=\/dev\//i, /:\(\)\s*\{.*\};\s*:/, // fork bomb
  /\bshutdown\b|\breboot\b/i, /\bcurl\b.*\|\s*(ba)?sh/i, /\bwget\b.*\|\s*(ba)?sh/i
];
function isDangerous(cmd) { return DANGEROUS_PATTERNS.some(re => re.test(cmd)); }

function safeResolve(p) {
  const abs = path.resolve(WORKSPACE, p);
  if (!(abs === WORKSPACE || abs.startsWith(WORKSPACE + path.sep) || abs.startsWith('/tmp') || abs.startsWith(os.tmpdir()))) {
    // allow absolute reads of common places but block writes outside workspace? keep simple: allow all for personal assistant, log it
  }
  return abs;
}

// ---------------- web search (keyless duckduckgo) ----------------
async function ddgSearch(query, maxResults = 6) {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (voice-agent)' },
    signal: AbortSignal.timeout(15000)
  });
  const html = await res.text();
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && results.length < maxResults) {
    let url = decodeURIComponent(m[1]);
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    const strip = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();
    results.push({ title: strip(m[2]), url, snippet: strip(m[3] || '') });
  }
  return results;
}

// ---------------- memory ----------------
function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); }
  catch { return { facts: [], history: [] }; }
}
function saveMemory(mem) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2));
}

// ---------------- TOOL DEFINITIONS ----------------
export const tools = {

  shell: {
    name: 'shell',
    description: 'Run a single shell command on the user\'s computer and return stdout/stderr. Use for files, apps, git, downloads, system info. Args: { command: string, cwd?: string, timeoutSec?: number }',
    async run({ command, cwd, timeoutSec = 60 }) {
      if (isDangerous(command)) throw new Error('BLOCKED: command considered destructive. Refusing to run.');
      const { stdout, stderr } = await pexec(command, {
        cwd: cwd ? safeResolve(cwd) : WORKSPACE,
        timeout: timeoutSec * 1000,
        maxBuffer: 4 * 1024 * 1024,
        shell: '/bin/bash'
      }).catch(e => {
        if (e.stdout !== undefined) return e; // execFile errors still carry output
        throw e;
      });
      const out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
      return out.slice(0, 8000) || '(no output)';
    }
  },

  read_file: {
    name: 'read_file',
    description: 'Read a text file. Args: { path: string }',
    async run({ path: p }) {
      return fs.readFileSync(safeResolve(p), 'utf8').slice(0, 20000);
    }
  },

  write_file: {
    name: 'write_file',
    description: 'Create or overwrite a text file (directories auto-created). Args: { path: string, content: string }',
    async run({ path: p, content }) {
      const abs = safeResolve(p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content ?? '');
      return `Wrote ${Buffer.byteLength(content || '')} bytes to ${abs}`;
    }
  },

  list_dir: {
    name: 'list_dir',
    description: 'List files in a directory. Args: { path: string }',
    async run({ path: p }) {
      const abs = safeResolve(p || '.');
      return fs.readdirSync(abs, { withFileTypes: true })
        .map(d => (d.isDirectory() ? '[dir] ' : '     ') + d.name).join('\n') || '(empty)';
    }
  },

  web_search: {
    name: 'web_search',
    description: 'Search the web (DuckDuckGo, no API key needed). Returns titles, URLs, snippets. Args: { query: string }',
    async run({ query }) {
      const r = await ddgSearch(query);
      if (!r.length) return 'No results found.';
      return r.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n');
    }
  },

  fetch_url: {
    name: 'fetch_url',
    description: 'Fetch a web page and return readable text (HTML stripped). Args: { url: string }',
    async run({ url }) {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
      const ct = res.headers.get('content-type') || '';
      let text = await res.text();
      if (ct.includes('json')) return text.slice(0, 8000);
      text = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
                 .replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
                 .replace(/\s+/g, ' ').trim();
      return text.slice(0, 8000);
    }
  },

  open_app: {
    name: 'open_app',
    description: 'Open an application or URL in the default program. Args: { target: string } e.g. "Chrome", "code", "https://youtube.com"',
    async run({ target }) {
      const platform = os.platform();
      let cmd, argsArr;
      if (/^https?:\/\//i.test(target)) {
        cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
        argsArr = platform === 'win32' ? ['/c', 'start', '', target] : [target];
      } else {
        cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
        argsArr = platform === 'darwin' ? ['-a', target] : platform === 'win32' ? ['/c', 'start', '', target] : [target];
      }
      await pexec(cmd, argsArr);
      return `Opened: ${target}`;
    }
  },

  http_request: {
    name: 'http_request',
    description: 'Send an HTTP request to any REST API. Args: { method, url, headers?: object, body?: string|object }',
    async run({ method = 'GET', url, headers = {}, body }) {
      const res = await fetch(url, {
        method: method.toUpperCase(),
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000)
      });
      const text = await res.text();
      return `HTTP ${res.status}\n${text.slice(0, 6000)}`;
    }
  },

  set_timer: {
    name: 'set_timer',
    description: 'Set a countdown timer that announces "Time\'s up!" when finished. Args: { seconds: number, label?: string }',
    async run({ seconds, label = 'Timer' }, ctx) {
      setTimeout(() => {
        if (ctx?.announce) ctx.announce(`${label}: time's up!`);
      }, Math.max(1, Number(seconds)) * 1000);
      return `Timer set for ${seconds}s (${label}). I will announce when it finishes.`;
    }
  },

  remember: {
    name: 'remember',
    description: 'Save a durable fact about the user or their preferences to long-term memory. Args: { fact: string }',
    async run({ fact }) {
      const mem = loadMemory();
      mem.facts = mem.facts.filter(f => f !== fact);
      mem.facts.unshift(fact);
      mem.facts = mem.facts.slice(0, 200);
      saveMemory(mem);
      return `Remembered: ${fact}`;
    }
  },

  recall: {
    name: 'recall',
    description: 'Look through long-term memory for stored facts/preferences. Args: { query?: string } (omit to dump all)',
    async run({ query }) {
      const mem = loadMemory();
      const items = query
        ? mem.facts.filter(f => f.toLowerCase().includes(String(query).toLowerCase()))
        : mem.facts;
      return items.length ? items.map(f => `- ${f}`).join('\n') : 'Nothing in memory matching that.';
    }
  },

  get_system_info: {
    name: 'get_system_info',
    description: 'Get machine info: OS, CPU, memory, uptime, home dir. No args.',
    async run() {
      return JSON.stringify({
        platform: os.platform(), arch: os.arch(), hostname: os.hostname(),
        cpus: os.cpus().length, totalMemGB: +(os.totalmem() / 1e9).toFixed(1),
        freeMemGB: +(os.freemem() / 1e9).toFixed(1), uptimeHrs: +(os.uptime() / 3600).toFixed(1),
        home: os.homedir()
      }, null, 2);
    }
  },

  ask_llm: {
    name: 'ask_llm',
    description: 'Ask the language model a pure-knowledge question (no tools) — useful inside plans for reasoning steps. Args: { prompt: string }',
    async run({ prompt }) {
      const r = await chat({ messages: [{ role: 'user', content: prompt }], temperature: 0.4 });
      return r.content.slice(0, 8000);
    }
  },

  finish: {
    name: 'finish',
    description: 'Call this when the overall goal is achieved. Provide a concise final summary for the user. Args: { summary: string }',
    async run({ summary }) { return `DONE::${summary}`; }
  }
};

export function toolCatalogText() {
  return Object.values(tools).map(t => `- ${t.name}: ${t.description}`).join('\n');
}

export function getMemoryFacts() {
  try { return loadMemory().facts.slice(0, 20); } catch { return []; }
}
