#!/usr/bin/env node
/**
 * TinkeDin Backchannel Server
 *
 * WebSocket server for real-time debugging and state introspection.
 *
 * Usage:
 *   node backchannel-server.js
 *
 * Then in another terminal:
 *   wscat -c ws://localhost:9777
 *   > {"cmd": "getState"}
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = 9777;

// Store the connected extension client
let extensionClient = null;
let lastState = null;
let stateHistory = [];

// Create HTTP server for simple REST queries
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/state') {
    res.end(JSON.stringify({
      connected: !!extensionClient,
      lastState,
      timestamp: Date.now()
    }, null, 2));
  } else if (req.url === '/history') {
    res.end(JSON.stringify(stateHistory.slice(-50), null, 2));
  } else if (req.url === '/health') {
    res.end(JSON.stringify({
      status: 'ok',
      contentScript: !!extensionClient,
      backgroundScript: !!global.backgroundClient,
    }));
  } else if (req.url === '/dom') {
    if (extensionClient) {
      extensionClient.send(JSON.stringify({ cmd: 'getDOM', selector: 'main', depth: 3 }));
      res.end(JSON.stringify({ status: 'command sent, check /state for results' }));
    } else {
      res.end(JSON.stringify({ error: 'Extension not connected' }));
    }
  } else if (req.url === '/tinder') {
    if (extensionClient) {
      extensionClient.send(JSON.stringify({ cmd: 'getTinderState' }));
      setTimeout(() => {
        res.end(JSON.stringify(global.lastTinderState || { error: 'No response yet' }, null, 2));
      }, 200);
    } else {
      res.end(JSON.stringify({ error: 'Extension not connected' }));
    }
  } else {
    res.end(JSON.stringify({
      endpoints: ['/state', '/history', '/health', '/dom', '/tinder'],
      wsEndpoint: `ws://localhost:${PORT}`,
      commands: ['getState', 'getDOM', 'getTinderState']
    }));
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  const clientType = req.headers['x-client-type'] || 'unknown';
  console.log(`[${timestamp()}] Client connected: ${clientType}`);

  if (clientType === 'extension') {
    extensionClient = ws;
    console.log(`[${timestamp()}] Extension connected!`);
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleMessage(ws, msg, clientType);
    } catch (e) {
      console.error(`[${timestamp()}] Invalid JSON:`, e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[${timestamp()}] Client disconnected: ${ws.clientType || clientType}`);
    if (ws === extensionClient) extensionClient = null;
    if (ws === global.backgroundClient) global.backgroundClient = null;
  });
});

function handleMessage(ws, msg, clientType) {
  console.log(`[${timestamp()}] [${clientType}] Received:`, JSON.stringify(msg).slice(0, 200));

  // Handle identify message from extension or background
  if (msg.type === 'identify') {
    ws.clientType = msg.client;
    if (msg.client === 'extension') {
      extensionClient = ws;
      console.log(`[${timestamp()}] Content script identified and registered!`);
    } else if (msg.client === 'background') {
      global.backgroundClient = ws;
      console.log(`[${timestamp()}] Background script identified and registered!`);
    }
    return;
  }

  // State update from the extension
  if (msg.type === 'stateUpdate') {
    lastState = msg.state;
    stateHistory.push({
      timestamp: Date.now(),
      state: msg.state
    });
    if (stateHistory.length > 100) {
      stateHistory = stateHistory.slice(-100);
    }
    broadcast(msg, ws);
    return;
  }

  // Log from the extension
  if (msg.type === 'log') {
    console.log(`[${timestamp()}] [EXT LOG] ${msg.message}`);
    broadcast(msg, ws);
    return;
  }

  // Response from the extension (exec result, DOM snapshot, etc.)
  if (['execResult', 'queryResult', 'domSnapshot', 'tinderState'].includes(msg.type)) {
    console.log(`[${timestamp()}] [RESPONSE] ${msg.type}`);
    if (msg.type === 'tinderState') {
      global.lastTinderState = msg.state;
    }
    broadcast(msg, ws);
    return;
  }

  // Command from an external client - forward to extension
  if (msg.cmd && extensionClient && extensionClient !== ws) {
    console.log(`[${timestamp()}] Forwarding command to extension: ${msg.cmd}`);
    extensionClient.send(JSON.stringify(msg));

    if (msg.cmd === 'getState') {
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'state',
          state: lastState,
          connected: !!extensionClient
        }));
      }, 100);
    }
    return;
  }

  // Direct query for state
  if (msg.cmd === 'getState') {
    ws.send(JSON.stringify({
      type: 'state',
      state: lastState,
      connected: !!extensionClient
    }));
  }
}

function broadcast(msg, exclude) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

httpServer.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║       TinkeDin Backchannel Server             ║
╠═══════════════════════════════════════════════╣
║  HTTP:  http://localhost:${PORT}                ║
║  WS:    ws://localhost:${PORT}                  ║
╠═══════════════════════════════════════════════╣
║  REST Endpoints:                              ║
║    GET /state   - Current extension state     ║
║    GET /history - State change history        ║
║    GET /health  - Connection status           ║
╠═══════════════════════════════════════════════╣
║  WebSocket Commands (JSON):                   ║
║    {"cmd": "getState"}  - Request state       ║
╚═══════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  wss.close();
  httpServer.close();
  process.exit(0);
});
