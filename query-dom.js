#!/usr/bin/env node
// Quick script to query DOM from extension
const WebSocket = require('ws');

const cmd = process.argv[2] || 'getDOM';
const selector = process.argv[3] || 'main';

const ws = new WebSocket('ws://localhost:9777');

ws.on('open', () => {
  if (cmd === 'dom') {
    ws.send(JSON.stringify({ cmd: 'getDOM', selector, depth: 3 }));
  } else if (cmd === 'query') {
    ws.send(JSON.stringify({ cmd: 'querySelector', selector, attrs: ['data-urn', 'class', 'textContent'] }));
  } else if (cmd === 'exec') {
    ws.send(JSON.stringify({ cmd: 'exec', code: selector }));
  } else {
    ws.send(JSON.stringify({ cmd, selector }));
  }
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data);
    // Accept any response type that's not a state update or log
    if (msg.type && !['stateUpdate', 'log', 'apiCall'].includes(msg.type)) {
      console.log(JSON.stringify(msg, null, 2));
      ws.close();
      process.exit(0);
    }
  } catch (e) {
    console.log(data.toString());
  }
});

setTimeout(() => {
  console.log('Timeout');
  ws.close();
}, 3000);
