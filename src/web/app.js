// ============================================================
// Frontend voice logic: STT (SpeechRecognition), TTS,
// wake word ("jarvis"), hands-free chaining, WS event stream.
// Works in browser AND inside the JARVIS Android APK (where a
// native VoiceSession object is injected before this script).
// ============================================================
const $ = id => document.getElementById(id);
let ws, selectedProviderId = null;

// ---------- Server base URL ----------
// In the APK, MainActivity injects window.JARVIS_BASE = "http://<ip>:8787"
// and window.JARVIS_NATIVE = true before loading the page.
const BASE = window.JARVIS_BASE || `${location.protocol}//${location.host}`;

// ---------- WebSocket ----------
let wsFails = 0;
function connectWS() {
  const url = BASE.replace(/^http/, 'ws') + '/ws';
  ws = new WebSocket(url);
  ws.onmessage = e => { wsFails = 0; handleAgentEvent(JSON.parse(e.data)); };
  ws.onclose = () => setTimeout(connectWS, 1500);
  ws.onerror = () => {
    if (++wsFails === 4 && window.JARVIS_NATIVE) {
      try { VoiceSession && VoiceSession.promptForServer(); } catch {}
    }
    try { ws.close(); } catch {}
  };
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
// Native (APK): window.VoiceSession.speak(text) uses Android TTS.
// Browser: Web Speech API.
let voices = [];
function loadVoices() { if (!window.JARVIS_NATIVE && 'speechSynthesis' in window) voices = speechSynthesis.getVoices(); }
if ('speechSynthesis' in window) { speechSynthesis.onvoiceschanged = loadVoices; loadVoices(); }

function pickVoice() {
  const pref = JSON.parse(localStorage.getItem('jarvisPrefs') || '{}');
  if (pref.voiceName) { const v = voices.find(v => v.name === pref.voiceName); if (v) return v; }
  return voices.find(v => /en[-_](GB|IN|US)/i.test(v.lang) && /male|daniel|google uk english male/i.test(v.name))
      || voices.find(v => /en/i.test(v.lang) && /natural|neural|google/i.test(v.name))
      || voices.find(v => /en/i.test(v.lang)) || null;
}
function speak(text) {
  if (!text) return;
  const clean = String(text).replace(/[*_#`]/g, '');
  if (window.JARVIS_NATIVE && window.VoiceSession) {
    setOrb('speaking');
    window.VoiceSession.speak(clean);        // app calls onTTSEnd() when done
    return;
  }
  if (!('speechSynthesis' in window)) { setOrb(''); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  const v = pickVoice(); if (v) u.voice = v;
  const prefs = JSON.parse(localStorage.getItem('jarvisPrefs') || '{}');
  u.rate = prefs.rate || 1.03; u.pitch = prefs.pitch || 0.9;
  u.onstart = () => setOrb('speaking');
  u.onend = u.onerror = () => onSpeakEnd();
  setOrb('speaking');
  speechSynthesis.speak(u);
}
// Called from Java when Android TTS finishes
function onTTSEnd() { onSpeakEnd(); }
function onSpeakEnd() {
  if (handsFree && !isBusyNow) startListening(true); // auto re-arm mic after speaking
  else setOrb(isBusyNow ? 'thinking' : '');
}
let isBusyNow = false;

// ---------- Speech-to-Text ----------
// Native (APK): window.VoiceSession.start()/stop() uses Android SpeechRecognizer.
// The app calls onNativeSpeech(finalText) with results.
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
} else if (!window.JARVIS_NATIVE) {
  $('micBtn').disabled = true;
  $('statusLine').textContent = 'Speech recognition not supported in this browser — use Chrome/Edge or the JARVIS Android app, or type commands below.';
}
let heardWakeThisUtterance = false;

// Native recognizer delivers final transcripts here (called from Java)
function onNativeSpeech(text) {
  if (!text) return;
  setStatus(text);
  handleCommand(text);
}
function onNativeListeningState(on) {
  if (on) setOrb('listening');
  else if (!isBusyNow && !window.__speaking) setOrb('');
}

function startListening(auto = false) {
  heardWakeThisUtterance = false;
  listeningWanted = true;
  setOrb('listening');
  setStatus(auto ? 'Listening for your next command…' : 'Speak now…');
  if (window.JARVIS_NATIVE && window.VoiceSession) { window.VoiceSession.start(); return; }
  if (!rec) return;
  try { rec.start(); } catch {}
}
function stopListening() {
  listeningWanted = false;
  if (window.JARVIS_NATIVE && window.VoiceSession) window.VoiceSession.stop();
  try { rec && rec.stop(); } catch {}
  setOrb('');
}

async function handleCommand(raw) {
  let cmd = raw.trim();
  // strip wake word if present
  cmd = cmd.replace(/^\s*(?:hey\s+)?(?:jarvis|jervis|jervais|server)[,\s]+/i, '').trim() || cmd;
  const low = cmd.toLowerCase();

  // local control phrases
  if (/^(stop|cancel|shut up|quiet|be quiet)\b/.test(low)) { send({ type: 'stop' }); haltSpeech(); stopListening(); setStatus('Stopped.'); return; }
  if (/^(go to sleep|sleep|stand down)\b/.test(low)) { setHandsFree(false); stopListening(); speak('Standing by.'); return; }
  if (/^(wake up|are you there|hello jarvis|you there)\b/.test(low)) { speak('At your service. What do you need?'); return; }

  addMsg('user', cmd);
  isBusyNow = true;
  setOrb('thinking');
  setStatus('On it — planning now…');
  send({ type: 'task', goal: cmd });
}
function haltSpeech() {
  if (window.JARVIS_NATIVE && window.VoiceSession) window.VoiceSession.cancelSpeech();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
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

$('stopBtn').onclick = () => { send({ type: 'stop' }); haltSpeech(); setStatus('Task stopped.'); };

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
  const st = await (await fetch(BASE + '/api/state')).json();
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
    if (Object.keys(patch).length) await fetch(`${BASE}/api/providers/${selectedProviderId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    await fetch(BASE + '/api/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: selectedProviderId, model }) });
    testResultEl('Saved & activated ✓');
    loadProviders(); closeSettings();
  }
}
async function addCustom() {
  const body = { name: $('cName').value.trim(), baseUrl: $('cUrl').value.trim(), model: $('cModel').value.trim(), apiKey: $('cKey').value.trim() };
  if (!body.name || !body.baseUrl) { testResultEl('Name and Base URL required', true); return; }
  const r = await (await fetch(BASE + '/api/providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (r.error) return testResultEl(r.error, true);
  await fetch(BASE + '/api/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: r.id, model: body.model }) });
  testResultEl('Custom provider added & activated ✓');
  ['cName','cUrl','cModel','cKey'].forEach(i => $(i).value = '');
  loadProviders();
}
async function testProvider() {
  testResultEl('Testing…');
  const prov = providersCache.find(p => p.id === selectedProviderId) || {};
  const body = { baseUrl: $('urlInput').value.trim() || prov.baseUrl, model: $('modelInput').value.trim() || prov.defaultModel, apiKey: $('keyInput').value.trim() || undefined };
  const r = await (await fetch(BASE + '/api/test-provider', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  testResultEl(r.ok ? `✓ Connected in ${r.ms}ms — replied "${r.reply}"` : `✗ ${r.error}`, !r.ok);
}
function testResultEl(t, err) { const el = $('testResult'); el.textContent = t; el.style.color = err ? 'var(--err)' : 'var(--acc)'; }

loadProviders();
setInterval(loadProviders, 15000);
