// ============================================================
// Frontend voice logic: STT (webkitSpeechRecognition), TTS,
// wake word ("jarvis"), hands-free chaining, WS event stream.
// ============================================================
const $ = id => document.getElementById(id);
let ws, selectedProviderId = null;

// ---------- WebSocket ----------
function connectWS() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = e => handleAgentEvent(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connectWS, 1500);
}
connectWS();

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); else setTimeout(() => send(msg), 400); }

// ---------- UI helpers ----------
function setStatus(t) { $('statusLine').textContent = t; }
function setOrb(state) { const o = $('orb'); o.className = state || ''; }
function addMsg(who, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  $('transcript').appendChild(d);
  $('transcript').scrollTop = 1e9;
}
function addLog(type, data) {
  const d = document.createElement('div');
  d.className = 'ev ' + type;
  const label = ({
    task_started: '🎯 GOAL', plan: '🗺 PLAN', thought: '💭 THINKING', action_started: '⚙ RUNNING',
    action_result: '✅ RESULT', action_failed: '❌ FAILED', replan: '🔄 REPLAN', switching_strategy: '🔀 NEW METHOD',
    verification_failed: '🧐 VERIFY REJECTED', task_done: '🏁 DONE', task_failed: '💥 GAVE UP', final: '📣 FINAL',
    announce: '⏰ ANNOUNCE', error: '⚠ ERROR', notice: 'ℹ NOTICE', task_aborted: '⏹ ABORTED'
  })[type] || type;
  let body = '';
  if (data.steps) body = data.steps.map(s => '   ' + s).join('\n');
  else if (data.args) body = `${data.tool} ${JSON.stringify(data.args).slice(0, 200)}`;
  else body = String(data.text || data.summary || data.output || data.message || data.reason || data.goal || '').slice(0, 600);
  d.innerHTML = `<b>${label}</b>\n` + body.replace(/&/g,'&amp;').replace(/</g,'&lt;');
  d.style.whiteSpace = 'pre-wrap';
  $('log').appendChild(d);
  while ($('log').children.length > 120) $('log').firstChild.remove();
  $('log').scrollTop = 1e9;
}

// ---------- Agent events ----------
let speakingQueue = [];
function handleAgentEvent(ev) {
  const { type, ...data } = ev;
  addLog(type, data);
  switch (type) {
    case 'task_started': setOrb('thinking'); $('stopBtn').style.display = ''; break;
    case 'thought': setStatus('Thinking: ' + String(data.text).slice(0, 80)); break;
    case 'action_started': setStatus(`Running ${data.tool}…`); break;
    case 'announce': speak(data.text); break;
    case 'task_done': case 'final':
      $('stopBtn').style.display = 'none';
      addMsg('ai', data.summary || data.text);
      speak(data.summary || data.text);
      break;
    case 'task_failed': case 'task_impossible':
      $('stopBtn').style.display = 'none';
      addMsg('ai', data.summary || data.reason);
      speak(data.summary || data.reason);
      setOrb('');
      break;
    case 'error': setOrb(''); $('stopBtn').style.display = 'none'; break;
  }
}

// ---------- Text-to-Speech ----------
let voices = [];
function loadVoices() { voices = speechSynthesis.getVoices(); }
speechSynthesis.onvoiceschanged = loadVoices; loadVoices();

function pickVoice() {
  const pref = JSON.parse(localStorage.getItem('jarvisPrefs') || '{}');
  if (pref.voiceName) { const v = voices.find(v => v.name === pref.voiceName); if (v) return v; }
  return voices.find(v => /en[-_](GB|IN|US)/i.test(v.lang) && /male|daniel|google uk english male/i.test(v.name))
      || voices.find(v => /en/i.test(v.lang) && /natural|neural|google/i.test(v.name))
      || voices.find(v => /en/i.test(v.lang)) || null;
}
function speak(text) {
  if (!text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(String(text).replace(/[*_#`]/g, ''));
  const v = pickVoice(); if (v) u.voice = v;
  const prefs = JSON.parse(localStorage.getItem('jarvisPrefs') || '{}');
  u.rate = prefs.rate || 1.03; u.pitch = prefs.pitch || 0.9;
  u.onstart = () => setOrb('speaking');
  u.onend = u.onerror = () => {
    if (handsFree && !isBusyNow) startListening(true); // auto re-arm mic after speaking
    else setOrb(isBusyNow ? 'thinking' : '');
  };
  setOrb('speaking');
  speechSynthesis.speak(u);
}
let isBusyNow = false;

// ---------- Speech-to-Text ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, handsFree = false, listeningWanted = false;

if (SR) {
  rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = (navigator.language || 'en-US');
  let baseTranscript = '';
  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) baseTranscript += r[0].transcript + ' ';
      else interim += r[0].transcript;
    }
    setStatus((baseTranscript + interim).trim() || 'Listening…');
    if (interim && /jervis|jarvis|server|jervais/i.test(interim) && !heardWakeThisUtterance) {
      heardWakeThisUtterance = true;
      setStatus(baseTranscript.trim() || 'Yes?');
    }
    if (baseTranscript.trim()) {
      const cmd = baseTranscript.trim();
      baseTranscript = '';
      handleCommand(cmd);
    }
  };
  rec.onend = () => { if (listeningWanted) { try { rec.start(); } catch {} } };
  rec.onerror = e => { if (e.error === 'not-allowed') { setStatus('Microphone permission denied.'); listeningWanted = false; } };
} else {
  $('micBtn').disabled = true;
  $('statusLine').textContent = 'Speech recognition not supported in this browser — use Chrome/Edge, or type commands below.';
}
let heardWakeThisUtterance = false;

function startListening(auto = false) {
  if (!rec) return;
  heardWakeThisUtterance = false;
  listeningWanted = true;
  setOrb('listening');
  setStatus(auto ? 'Listening for your next command…' : 'Speak now…');
  try { rec.start(); } catch {}
}
function stopListening() {
  listeningWanted = false;
  try { rec && rec.stop(); } catch {}
  setOrb('');
}

async function handleCommand(raw) {
  let cmd = raw.trim();
  // strip wake word if present
  cmd = cmd.replace(/^\s*(?:hey\s+)?(?:jarvis|jervis|jervais|server)[,\s]+/i, '').trim() || cmd;
  const low = cmd.toLowerCase();

  // local control phrases
  if (/^(stop|cancel|shut up|quiet|be quiet)\b/.test(low)) { send({ type: 'stop' }); speechSynthesis.cancel(); stopListening(); setStatus('Stopped.'); return; }
  if (/^(go to sleep|sleep|stand down)\b/.test(low)) { setHandsFree(false); stopListening(); speak('Standing by.'); return; }
  if (/^(wake up|are you there|hello jarvis|you there)\b/.test(low)) { speak('At your service. What do you need?'); return; }

  addMsg('user', cmd);
  isBusyNow = true;
  setOrb('thinking');
  setStatus('On it — planning now…');
  send({ type: 'task', goal: cmd });
}

$('micBtn').onclick = () => { listeningWanted ? stopListening() : startListening(); };
$('handsfreeBtn').onclick = () => setHandsFree(!handsFree);
function setHandsFree(on) {
  handsFree = on;
  $('handsfreeBtn').textContent = `🙌 Hands-free: ${on ? 'ON' : 'OFF'}`;
  $('handsfreeBtn').classList.toggle('active', on);
  localStorage.setItem('jarvisHF', on ? '1' : '0');
  if (on && !listeningWanted) startListening(true);
  if (!on) stopListening();
}
if (localStorage.getItem('jarvisHF') === '1') setHandsFree(true);

$('stopBtn').onclick = () => { send({ type: 'stop' }); speechSynthesis.cancel(); setStatus('Task stopped.'); };

$('textInput').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.value.trim()) { sendText(); } });
function sendText() { const v = $('textInput').value.trim(); if (!v) return; $('textInput').value = ''; handleCommand(v); }

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')) {
    e.preventDefault(); listeningWanted ? stopListening() : startListening();
  }
});

// reflect busy state from server log events
const _origHandle = handleAgentEvent;
window.handleAgentEvent = ev => {
  if (ev.type === 'task_done' || ev.type === 'final' || ev.type === 'task_failed' || ev.type === 'task_impossible' || ev.type === 'task_aborted') isBusyNow = false;
  _origHandle(ev);
};

// ---------- Settings / Providers ----------
let providersCache = [];
async function loadProviders() {
  const st = await (await fetch('/api/state')).json();
  providersCache = st.providers;
  const active = st.providers.find(p => p.id === st.activeProviderId) || st.providers[0];
  $('badgeName').textContent = active?.name || '?';
  $('badgeModel').textContent = st.activeModel || active?.defaultModel || '';
  const list = $('provList'); list.innerHTML = '';
  providersCache.forEach(p => {
    const d = document.createElement('div');
    d.className = 'provitem' + (p.id === st.activeProviderId ? ' sel' : '');
    d.innerHTML = `<div><b>${p.name}</b> <span class="pill">${p.builtin ? 'preset' : 'custom'}</span><small>${p.baseUrl}</small></div><small>${p.defaultModel || ''}</small>`;
    d.onclick = () => {
      document.querySelectorAll('.provitem').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel');
      selectedProviderId = p.id;
      $('modelInput').value = st.activeModel || p.defaultModel || '';
      const dl = $('modelList'); dl.innerHTML = '';
      (p.models || []).forEach(m => dl.insertAdjacentHTML('beforeend', `<option value="${m}">`));
    };
    list.appendChild(d);
    if (p.id === st.activeProviderId) selectedProviderId = p.id;
  });
}
function openSettings() { loadProviders(); $('settingsDlg').showModal(); }
function closeSettings() { $('settingsDlg').close(); }

async function saveProvider() {
  const model = $('modelInput').value.trim();
  const apiKey = $('keyInput').value.trim();
  const baseUrl = $('urlInput').value.trim();
  const patch = {};
  if (apiKey) patch.apiKey = apiKey;
  if (baseUrl) patch.baseUrl = baseUrl;
  if (selectedProviderId) {
    if (Object.keys(patch).length) await fetch(`/api/providers/${selectedProviderId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    await fetch('/api/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: selectedProviderId, model }) });
    speak && testResultEl('Saved & activated ✓');
    loadProviders(); closeSettings();
  }
}
async function addCustom() {
  const body = { name: $('cName').value.trim(), baseUrl: $('cUrl').value.trim(), model: $('cModel').value.trim(), apiKey: $('cKey').value.trim() };
  if (!body.name || !body.baseUrl) { testResultEl('Name and Base URL required', true); return; }
  const r = await (await fetch('/api/providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (r.error) return testResultEl(r.error, true);
  await fetch('/api/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: r.id, model: body.model }) });
  testResultEl('Custom provider added & activated ✓');
  ['cName','cUrl','cModel','cKey'].forEach(i => $(i).value = '');
  loadProviders();
}
async function testProvider() {
  testResultEl('Testing…');
  const prov = providersCache.find(p => p.id === selectedProviderId) || {};
  const body = { baseUrl: $('urlInput').value.trim() || prov.baseUrl, model: $('modelInput').value.trim() || prov.defaultModel, apiKey: $('keyInput').value.trim() || undefined };
  const r = await (await fetch('/api/test-provider', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  testResultEl(r.ok ? `✓ Connected in ${r.ms}ms — replied "${r.reply}"` : `✗ ${r.error}`, !r.ok);
}
function testResultEl(t, err) { const el = $('testResult'); el.textContent = t; el.style.color = err ? 'var(--err)' : 'var(--acc)'; }

loadProviders();
setInterval(loadProviders, 15000);
