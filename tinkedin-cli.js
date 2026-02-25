#!/usr/bin/env node
/**
 * TinkeDin CLI - Query and control the extension via backchannel
 *
 * Usage:
 *   node tinkedin-cli.js state        # Get current state
 *   node tinkedin-cli.js watch        # Watch for updates
 *   node tinkedin-cli.js health       # Check server health
 *   node tinkedin-cli.js history      # Show state change history
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = 9777;
const args = process.argv.slice(2);
const command = args[0] || 'state';

// Simple HTTP fetch for quick queries
function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

// Watch mode - stream updates
function watch() {
  console.log('Watching for updates... (Ctrl+C to exit)\n');

  const ws = new WebSocket(`ws://localhost:${PORT}`);

  ws.on('open', () => {
    console.log('Connected to backchannel\n');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const time = new Date().toLocaleTimeString();

      if (msg.type === 'stateUpdate') {
        console.log(`[${time}] State Update:`);
        console.log(`  Hidden: ${msg.state.hiddenCount} | Liked: ${msg.state.likedCount}`);
      } else if (msg.type === 'log') {
        console.log(`[${time}] LOG: ${msg.message}`);
      } else {
        console.log(`[${time}]`, JSON.stringify(msg, null, 2));
      }
    } catch (e) {
      console.log(data.toString());
    }
  });

  ws.on('close', () => {
    console.log('\nDisconnected');
    process.exit(0);
  });

  ws.on('error', (e) => {
    console.error('Connection error:', e.message);
    process.exit(1);
  });
}

// Main
async function main() {
  try {
    switch (command) {
      case 'state':
      case 's':
        const state = await httpGet('/state');
        console.log('\nTinkeDin State:');
        console.log('───────────────────────────────');
        console.log(`Connected:    ${state.connected ? '✓ Yes' : '✗ No'}`);
        if (state.lastState) {
          const s = state.lastState;
          console.log(`Hidden:       ${s.hiddenCount || 0}`);
          console.log(`Liked:        ${s.likedCount || 0}`);
          console.log(`Enabled:      ${s.enabled ? 'ON' : 'OFF'}`);
        } else {
          console.log('(No state data yet - open LinkedIn)');
        }
        console.log('───────────────────────────────\n');
        break;

      case 'watch':
      case 'w':
        watch();
        return; // Don't exit, watch runs continuously

      case 'health':
        const health = await httpGet('/health');
        console.log(health.status === 'ok' ? '✓ Server OK' : '✗ Server issue');
        console.log(`Extension: ${health.connected ? 'connected' : 'not connected'}`);
        break;

      case 'history':
        const history = await httpGet('/history');
        console.log(`\nLast ${history.length} state changes:`);
        history.slice(-10).forEach(h => {
          const time = new Date(h.timestamp).toLocaleTimeString();
          console.log(`  [${time}] Hidden: ${h.state.hiddenCount || 0}, Liked: ${h.state.likedCount || 0}`);
        });
        break;

      default:
        console.log(`
TinkeDin CLI - Control your extension from the terminal

Commands:
  state, s      Show current extension state
  watch, w      Watch for live updates
  health        Check server health
  history       Show state change history

Usage:
  node tinkedin-cli.js <command>
`);
    }
  } catch (e) {
    console.error('Error:', e.message);
    console.log('\nMake sure the backchannel server is running:');
    console.log('  node backchannel-server.js');
    process.exit(1);
  }
}

main();
