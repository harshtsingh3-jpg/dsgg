# ◉ JARVIS — Hands-Free AI Voice Agentic Assistant

A self-hosted voice assistant that **plans → executes on your computer → verifies → and if it fails, retries with a NEW method** — all hands-free. Talk to it from your phone or laptop browser; no app install needed. It connects to **NVIDIA NIM, OpenRouter, Ollama, OpenAI, Groq, or ANY custom model** you point it at (provider name + base URL + model name + API key).

---

## ✨ What it does

| Feature | How |
|---|---|
| 🎤 **Voice in** | Browser speech recognition (Chrome/Edge), wake-word tolerant ("Jarvis…"), continuous **hands-free mode** that re-arms the mic after every reply |
| 🗣 **Voice out** | Speech synthesis with a deep assistant voice; final summaries are spoken aloud |
| 🧠 **Plans first** | Breaks your goal into 3–7 steps, shows the live plan in the UI |
| ⚙ **Executes for real** | Tools: shell, read/write/list files, web search (keyless DuckDuckGo), fetch URL, open apps, REST calls, timers, system info, long-term memory (`remember`/`recall`) |
| 🔁 **Self-healing** | Every failure is fed back to the model with the list of *already-failed attempts* and it MUST generate a genuinely different method (up to 4 re-plans); a **verification gate** rejects premature "done" claims |
| 🔌 **Any provider / any model** | Presets for NVIDIA NIM · OpenRouter · Ollama · OpenAI · Groq + fully custom endpoints (name/baseURL/model/key), one-click connection test |
| 📱 **Phone friendly** | Served over LAN — open `http://<your-pc-ip>:8787` on your phone, add to home screen, talk across the room |

---

## 🚀 Quick start

```bash
npm install
npm start          # → http://localhost:8787  (+ LAN URL printed for your phone)
```

Open the page in **Chrome or Edge** (needed for speech recognition), click **🎤 Start Listening** (or press **Spacebar**), then just say:

> *"Jarvis, make a folder called Projects, create a python hello world there, run it and tell me the output."*

Watch the right-hand panel: **GOAL → PLAN → thoughts → tool runs → results → (if something fails) REPLAN with a new method → DONE**, and hear the spoken summary.

### Voice commands understood natively
- **"stop" / "cancel" / "be quiet"** — abort current task & speech
- **"go to sleep"** — turn off hands-free listening
- **"wake up" / "hello jarvis"** — acknowledgement
- Anything else becomes a **goal** for the agent.

---

## 🔌 Connecting providers (⚙ top-right)

| Provider | Base URL | Key |
|---|---|---|
| **NVIDIA NIM** | `https://integrate.api.nvidia.com/v1` | `nvapi-…` from build.nvidia.com |
| **OpenRouter** | `https://openrouter.ai/api/v1` | from openrouter.ai/keys |
| **Ollama (local)** | `http://localhost:11434/v1` | none — just `ollama serve` |
| **Custom (vLLM / LM Studio / llama.cpp / anything)** | e.g. `http://192.168.1.50:8000/v1` | optional |

You can type **any model name** even if it isn't in the dropdown (e.g. `deepseek-ai/deepseek-r1`, `qwen2.5-coder-32b`). Use **🔌 Test Connection** to verify before saving. Keys are stored locally in `data/providers.json` and shown masked in the UI.

> Tip: switch models mid-conversation — the next task instantly uses the new brain. The agent also has an `ask_llm` tool so plans can call the model for pure reasoning steps.

---

## 🧬 The agentic loop (src/core/agent.js)

```
GOAL ─▶ PLAN (steps) ─▶ ACT (tool+args) ─▶ OBSERVE result
                 ▲                              │ fail?
                 │                              ▼
                 └──── REPLAN: error + list of FAILED signatures ────┐
                        ("DO NOT repeat these exactly")              │
DONE claim ─▶ VERIFIER LLM checks evidence in history ──reject──▶───┘
```

- Bounded: 24 tool-steps, 4 full re-plans per task → never loops forever.
- Temperature rises during re-plans (more creative alternative methods).
- Destructive commands (`rm -rf /`, `mkfs`, pipe-to-shell, …) are blocked.

## 🗂 Project layout

```
server.js                  Express + WebSocket entry point
src/core/agent.js          Plan→Act→Verify→Replan loop
src/providers/registry.js  Presets + custom providers (persisted)
src/providers/llm.js       OpenAI-compatible client + robust JSON parsing
src/tools/registry.js      shell/files/web/apps/timers/memory/http tools
src/web/index.html         Voice UI (orb, transcript, live activity log)
src/web/app.js             STT, TTS, wake word, hands-free chaining, WS
test/                      mock LLM + E2E harness (node test/mock-llm.js)
data/                      providers.json, memory.json (auto-created)
```

## 🧪 Testing

```bash
node test/mock-llm.js &            # fake OpenAI-compatible server :8899
node server.js &                   # add provider baseUrl http://localhost:8899/v1
node test/e2e.js                   # drives a full task over WebSocket
```

The E2E harness verifies both paths: task success (write→verify→finish passes the verifier) and provider-down handling (bounded retries then clean `task_failed`).

## ⚠️ Notes
- Microphone requires `http://localhost` or HTTPS on non-localhost origins (browsers block mic on plain LAN http — use `localhost` via port-forward/SSH tunnel, or a local HTTPS proxy like `local-ssl-proxy`, or ngrok/Tailscale HTTPS).
- The agent executes real shell commands on your machine — set `AGENT_WORKSPACE=/some/dir` to sandbox file operations (default: your home dir).

*Made for people who'd rather talk than type.*
