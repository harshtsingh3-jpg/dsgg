// ============================================================
// JARVIS Voice Agent — main server
//   • Express REST API (providers, settings) + static web UI
//   • WebSocket for voice commands & live agent event stream
// Run:  npm start   →  open http://localhost:8787 in Chrome/Edge
// ============================================================
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

import * as registry from './src/providers/registry.js';
import { runTask, stopCurrentTask, isBusy } from './src/core/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'src', 'web')));

// ---------- REST: providers ----------
app.get('/api/state', (req, res) => res.json(registry.getState()));

app.post('/api/providers', (req, res) => {
  try {
    const p = registry.addCustomProvider(req.body || {});
    res.json(p);
  } catch (e) { res.json({ error: e.message }); }
});

app.patch('/api/providers/:id', (req, res) => {
  const p = registry.updateProvider(req.params.id, req.body || {});
  res.json(p ? registry.getState().providers.find(x => x.id === req.params.id) : { error: 'not found' });
});

app.delete('/api/providers/:id', (req, res) => {
  registry.removeProvider(req.params.id);
  res.json({ ok: true });
});

app.post('/api/active', (req, res) => {
  const { providerId, model } = req.body || {};
  if (!providerId) return res.json({ error: 'providerId required' });
  registry.setActive(providerId, model);
  res.json(registry.getActiveConfig().name ? { ok: true, active: mask(registry.getActiveConfig()) } : { error: 1 });
});

app.post('/api/test-provider', async (req, res) => {
  const { baseUrl, model, apiKey } = req.body || {};
  let cfg = { baseUrl, model, apiKey };
  if (!baseUrl) cfg = registry.getActiveConfig();
  // if apiKey masked/empty, use stored one
  if (!cfg.apiKey) {
    const stored = registry.getProvider(cfg.id || registry.getState().activeProviderId);
    cfg.apiKey = stored?.apiKey || '';
  }
  try {
    const r = await registry.testProvider(cfg);
    res.json(r);
  } catch (e) {
    res.json({ ok: false, error: e.message.slice(0, 300) });
  }
});

app.get('/api/status', (req, res) => res.json({ busy: isBusy(), active: mask(registry.getActiveConfig()) }));

function mask(c) { return { ...c, apiKey: c.apiKey ? 'set' : '' }; }

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', ws => {
  const emit = (type, data = {}) => { try { ws.send(JSON.stringify({ type, ...data })); } catch {} };
  emit('hello', { msg: 'Connected to JARVIS agent core.' });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'stop') {
      stopCurrentTask();
      emit('task_aborted', {});
      return;
    }

    if (msg.type === 'task') {
      if (isBusy()) return emit('notice', { message: 'Already working on a task — say "stop" first.' });
      const goal = String(msg.goal || '').slice(0, 4000);
      if (!goal.trim()) return;
      runTask(goal, emit).catch(e => emit('error', { message: e.message }));
    }
  });
});

// ---------- start ----------
server.listen(PORT, () => {
  const nets = [];
  Object.values(os.networkInterfaces()).flat().forEach(n => { if (n && n.family === 'IPv4' && !n.internal) nets.push(n.address); });
  console.log('┌───────────────────────────────────────────────┐');
  console.log('│   ◉ JARVIS VOICE AGENT — hands-free AI        │');
  console.log('└───────────────────────────────────────────────┘');
  console.log(`  Local:   http://localhost:${PORT}`);
  nets.forEach(ip => console.log(`  Network: http://${ip}:${PORT}  (open this on your phone)`));
  const active = registry.getActiveConfig();
  console.log(`  Provider: ${active.name} (${active.model}) @ ${active.baseUrl}`);
  console.log('  Tip: press ⚙ top-right to switch NVIDIA NIM / OpenRouter / Ollama / custom.');
});
