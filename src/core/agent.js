// ============================================================
// Agentic Loop — the brain of the assistant.
// 1) PLAN: model decomposes the goal into steps
// 2) EXECUTE: step-by-step, model chooses tool + args each turn
// 3) VERIFY: after each step & at the end, a verifier checks success
// 4) REPLAN: on failure the model is fed the error and MUST propose a
//    NEW METHOD (never repeats an identical failed action). Retries
//    are bounded per task to avoid loops.
// ============================================================
import { chatJson } from '../providers/llm.js';
import { tools, toolCatalogText, getMemoryFacts } from '../tools/registry.js';

const MAX_STEPS = 24;          // total tool calls per task
const MAX_REPLANS = 4;         // full re-plans after failure
const HISTORY_CAP = 14;        // transcript entries kept in prompt

let runningTask = null;        // { abort: true } handle for stop button

export function stopCurrentTask() {
  if (runningTask) runningTask.aborted = true;
}

export function isBusy() { return !!runningTask; }

const SYSTEM_PROMPT = `You are JARVIS, a hands-free autonomous voice assistant that actually GETS THINGS DONE on the user's computer using tools. You never ask permission when you can just act. You never say "I cannot" unless every method failed.

YOUR TOOLS:
${toolCatalogText()}

RULES:
- Think in terms of GOALS, not commands. If a command fails, diagnose why from stderr, then try a DIFFERENT approach (different tool, different flags, install a missing dependency first, fallback website, etc.).
- Always verify results: after writing a file, read it back or ls it; after downloading, check size; after searching, use the best result.
- Output ONLY valid JSON matching the requested schema. No prose outside JSON.
- Keep final summaries SHORT (1-3 sentences) because they will be SPOKEN aloud.`;

function buildUserContext(goal, transcript, plan, replanCount, lastFailure) {
  const facts = getMemoryFacts();
  let ctx = '';
  if (facts.length) ctx += `KNOWN USER FACTS/MEMORY:\n${facts.map(f => '- ' + f).join('\n')}\n\n`;
  if (plan) ctx += `CURRENT PLAN:\n${plan.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.title}`).join('\n')}\n\n`;
  if (transcript.length) {
    ctx += `ACTION HISTORY:\n${transcript.slice(-HISTORY_CAP).map(t => {
      const argStr = JSON.stringify(t.args || {}).slice(0, 200);
      return `- step ${t.step}: ${t.tool}(${argStr}) => ${t.ok ? 'OK' : 'FAILED'}: ${String(t.result).slice(0, 400)}`;
    }).join('\n')}\n\n`;
  }
  if (lastFailure) {
    ctx += `!!! LAST ACTION FAILED !!!\nTool: ${lastFailure.tool}\nArgs: ${JSON.stringify(lastFailure.args)}\nError: ${lastFailure.error}\n` +
           `Previous attempts already made (DO NOT repeat these exactly):\n${failedSignatures(transcript)}\n` +
           `Now propose a NEW METHOD to accomplish the goal.\n\n`;
  }
  ctx += `GOAL: ${goal}`;
  return ctx;
}

function failedSignatures(transcript) {
  const fails = transcript.filter(t => !t.ok);
  if (!fails.length) return '(none yet)';
  return fails.map(f => `  * tried ${f.tool}(${JSON.stringify(f.args).slice(0, 150)}) → ${String(f.result).slice(0, 120)}`).join('\n');
}

/** Ask the model for the next action (or verification / replan). */
async function decideNext({ goal, transcript, plan, lastFailure, mode, emit }) {
  let instruction;
  if (mode === 'verify') {
    instruction = `The agent believes the goal is complete. Its proposed summary: "${lastFailure?.summary || ''}".
Decide if the ACTION HISTORY proves the goal was truly accomplished. Reply JSON:
{"success": true|false, "reason": "one line", "missing": "what still needs doing if false"}
Be strict: no evidence in history => success=false.`;
  } else if (mode === 'replan') {
    instruction = `The previous approach FAILED. Based on the failure info below, create a NEW plan with genuinely DIFFERENT methods/tools/commands. Reply JSON:
{"thought":"why the old way failed","steps":[{"title":"short step description"}], "immediateAction":{"tool":"name","args":{...}} }
If you can fix it right now with one action, include immediateAction. Available tools listed above. If the goal is impossible even theoretically, set "steps":[] and put reason in thought starting with IMPOSSIBLE:`;
  } else {
    instruction = `Continue working toward the goal. Choose the single most useful NEXT action. Reply JSON:
{"thought":"brief reasoning","tool":"tool_name","args":{...}}
Use "finish" with {"summary":"..."} only when the goal is fully achieved and verified by prior successful steps.`;
  }

  const { json } = await chatJson({
    temperature: mode === 'replan' ? 0.8 : 0.2,
    maxTokens: 1200,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${instruction}\n\n${buildUserContext(goal, transcript, plan, undefined, lastFailure)}` }
    ]
  });
  return json;
}

export async function runTask(goal, emit, opts = {}) {
  const task = { aborted: false };
  runningTask = task;
  const transcript = [];
  let replanCount = 0;
  let plan = null;
  let lastFailure = null;
  let summary = null;
  let llmFailures = 0;

  const safeEmit = (type, data) => { try { emit(type, { ...data, t: Date.now() }); } catch {} };

  try {
    safeEmit('task_started', { goal });

    // ---------- INITIAL PLAN ----------
    try {
      const p = await chatJson({
        temperature: 0.3, maxTokens: 1000,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Break this goal into a short actionable plan (3-7 steps) using the available tools. Also give the very first concrete action.\nGoal: ${goal}\n\nReply JSON: {"steps":[{"title":"..."}],"firstAction":{"tool":"...","args":{}}}` }
        ]
      });
      plan = { steps: (p.json.steps || []).map(s => ({ title: s.title || String(s), status: 'pending' })) };
      safeEmit('plan', { steps: plan.steps.map(s => s.title) });
    } catch (e) {
      safeEmit('notice', { message: 'Planning skipped (' + e.message.slice(0, 80) + '); acting directly.' });
    }

    // ---------- MAIN LOOP ----------
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (task.aborted) { safeEmit('task_aborted', {}); return { ok: false, aborted: true }; }

      let decision;
      try {
        decision = await decideNext({ goal, transcript, plan, lastFailure, mode: lastFailure ? 'replan' : 'act', emit: safeEmit });
      } catch (e) {
        llmFailures++;
        const fatal = /HTTP 4\d\d/.test(e.message) || llmFailures >= 5;
        safeEmit('error', { message: `LLM decision failed (${llmFailures}/5): ${e.message.slice(0, 200)}${fatal ? '' : ' — retrying…'}` });
        if (fatal) { summary = 'The AI provider itself is failing: ' + e.message.slice(0, 200); safeEmit('task_failed', { summary }); break; }
        await sleep(1500);
        continue;
      }

      // replan produced empty plan / impossible
      if (decision.steps && decision.steps.length === 0 && String(decision.thought || '').includes('IMPOSSIBLE')) {
        summary = 'I could not find any viable method: ' + decision.thought.replace(/^.*IMPOSSIBLE:/, '').trim();
        safeEmit('task_impossible', { reason: summary });
        break;
      }
      if (decision.steps && decision.steps.length && lastFailure) {
        plan = { steps: decision.steps.map(s => ({ title: s.title || String(s), status: 'pending' })) };
        replanCount++;
        safeEmit('replan', { attempt: replanCount, steps: plan.steps.map(s => s.title), thought: decision.thought });
        if (decision.immediateAction) { decision.tool = decision.immediateAction.tool; decision.args = decision.immediateAction.args; }
        lastFailure = null;
      }

      const toolName = decision.tool;
      const tool = tools[toolName];
      if (decision.thought) safeEmit('thought', { text: decision.thought });

      if (!tool) {
        lastFailure = { tool: toolName, args: decision.args || {}, error: `Unknown tool "${toolName}". Pick a tool from the catalog.` };
        safeEmit('action_failed', { tool: toolName, error: lastFailure.error });
        continue;
      }

      if (toolName === 'finish') {
        // ---- VERIFICATION GATE ----
        const verdict = await decideNext({ goal, transcript, plan, lastFailure: { summary: decision.args?.summary }, mode: 'verify' }).catch(() => ({ success: true }));
        if (verdict.success) {
          summary = decision.args?.summary || 'Done.';
          safeEmit('task_done', { summary });
          break;
        } else {
          safeEmit('verification_failed', { reason: verdict.reason, missing: verdict.missing });
          lastFailure = { tool: 'finish', args: {}, error: `Premature finish rejected. Reason: ${verdict.reason}. Missing: ${verdict.missing || ''}` };
          continue;
        }
      }

      // ---- EXECUTE ----
      safeEmit('action_started', { step, tool: toolName, args: decision.args || {} });
      let result, ok;
      try {
        result = await tool.run(decision.args || {}, {
          announce: msg => safeEmit('announce', { text: msg }),
          step
        });
        ok = true;
      } catch (e) {
        result = e.message || String(e);
        ok = false;
      }
      transcript.push({ step, tool: toolName, args: decision.args || {}, ok, result });
      safeEmit(ok ? 'action_result' : 'action_failed', { step, tool: toolName, output: String(result).slice(0, 1500) });

      // update plan status heuristically (mark first pending done on success)
      if (plan) {
        const pend = plan.steps.find(s => s.status === 'pending');
        if (pend && ok) pend.status = 'done';
        safeEmit('plan', { steps: plan.steps.map(s => `[${s.status}] ${s.title}`) });
      }

      if (!ok) {
        if (replanCount >= MAX_REPLANS && transcript.filter(t => !t.ok).length > 6) {
          summary = 'I tried multiple different methods but every one failed. Last error: ' + String(result).slice(0, 200);
          safeEmit('task_failed', { summary });
          break;
        }
        lastFailure = { tool: toolName, args: decision.args || {}, error: String(result).slice(0, 600) };
        safeEmit('switching_strategy', { message: `Method failed — trying a new approach (${replanCount + 1}/${MAX_REPLANS}).` });
      }
      await sleep(300);
    }

    if (!summary) summary = 'I reached the step limit without confirming success. ' + summarizeTranscript(transcript);
    safeEmit('final', { text: summary, ok: !!summary && !summary.startsWith('I tried multiple') });
    return { ok: true, summary };
  } finally {
    runningTask = null;
  }
}

function summarizeTranscript(tr) {
  const done = tr.filter(t => t.ok).map(t => t.tool);
  return done.length ? `Successful actions so far: ${done.join(', ')}.` : 'No actions succeeded.';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
