#!/usr/bin/env node
// Mock OpenAI-compatible server for end-to-end testing of the agent loop.
import http from 'http';

http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    const user = (payload.messages.filter(m => m.role === 'user').pop() || {}).content || '';
    let content;
    if (user.startsWith('Break this goal')) {
      content = JSON.stringify({ steps: [{ title: 'Create the file' }, { title: 'Verify it exists' }] });
    } else if (user.startsWith('The agent believes')) {
      content = JSON.stringify({ success: true, reason: 'history shows write + read verification', missing: '' });
    } else if (user.startsWith('The previous approach FAILED')) {
      content = JSON.stringify({ thought: 'old way failed, using different method', steps: [{ title: 'verify with read_file instead' }], immediateAction: { tool: 'read_file', args: { path: '/tmp/mock_test.txt' } } });
    } else if (user.includes('ACTION HISTORY') && user.includes('write_file')) {
      content = JSON.stringify({ thought: 'verify result', tool: 'read_file', args: { path: '/tmp/mock_test.txt' } });
    } else if (user.includes('ACTION HISTORY') && user.includes('read_file')) {
      content = JSON.stringify({ thought: 'goal achieved', tool: 'finish', args: { summary: 'Created /tmp/mock_test.txt and verified its contents.' } });
    } else {
      content = JSON.stringify({ thought: 'start working', tool: 'write_file', args: { path: '/tmp/mock_test.txt', content: 'hello from mock-driven agent' } });
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
}).listen(8899, () => console.log('mock LLM on 8899'));
