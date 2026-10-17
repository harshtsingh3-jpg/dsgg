// E2E test: point agent at mock LLM, run a task through the real loop.
import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:8787/ws');
let done = false;
ws.on('open', () => ws.send(JSON.stringify({ type: 'task', goal: 'Create /tmp/mock_test.txt with content and verify it' })));
ws.on('message', d => {
  const ev = JSON.parse(d);
  console.log(`[${ev.type}]`, JSON.stringify(ev).slice(0, 160));
  if (['final', 'task_failed', 'task_impossible', 'error'].includes(ev.type)) {
    done = true;
    ws.close();
    process.exit(ev.type === 'final' ? 0 : 1);
  }
});
setTimeout(() => { if (!done) { console.error('TIMEOUT'); process.exit(2); } }, 30000);
