// TinkeDin Background Script (v2)
// Backchannel WebSocket + storage queries + P2P sync via PeerJS

let backchannelSocket = null;

function connectBackchannel() {
  try {
    backchannelSocket = new WebSocket('ws://localhost:9777');
    backchannelSocket.onopen = () => {
      backchannelSocket.send(JSON.stringify({ type: 'identify', client: 'background' }));
      log('Backchannel connected');
    };
    backchannelSocket.onclose = () => setTimeout(connectBackchannel, 5000);
    backchannelSocket.onerror = () => {};
  } catch (e) {
    setTimeout(connectBackchannel, 5000);
  }
}

function log(msg) {
  console.log(`[TinkeDin] ${msg}`);
  if (backchannelSocket?.readyState === WebSocket.OPEN) {
    backchannelSocket.send(JSON.stringify({ type: 'log', message: `[BG] ${msg}` }));
  }
}

// ============================================
// P2P SYNC (PeerJS + AES-GCM)
// ============================================

let syncPeer = null;
let syncConn = null;
let syncEncKey = null;
let syncStatus = 'disconnected'; // disconnected | connecting | waiting | connected
let syncReconnectTimer = null;

// Derive a deterministic peer ID from the shared secret + slot index
async function derivePeerId(secret, slot) {
  const encoder = new TextEncoder();
  const data = encoder.encode('tinkedin-sync-' + secret + '-' + slot);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  return 'td-' + hex.slice(0, 16);
}

// Derive AES-256-GCM key from secret via PBKDF2
async function deriveEncryptionKey(secret) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode('tinkedin-sync-salt'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptPayload(key, plaintext) {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext)
  );
  // Concatenate iv + ciphertext, base64 encode
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptPayload(key, encoded) {
  const combined = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}

async function startSync(secret) {
  if (syncPeer) stopSync();
  clearTimeout(syncReconnectTimer);

  setSyncStatus('connecting');
  log('Sync: starting with secret ' + secret.slice(0, 6) + '...');

  try {
    syncEncKey = await deriveEncryptionKey(secret);
    const slotA = await derivePeerId(secret, 0);
    const slotB = await derivePeerId(secret, 1);

    log('Sync: trying slot A: ' + slotA);

    // Try to register as slotA first
    syncPeer = new Peer(slotA, { debug: 0 });

    syncPeer.on('open', (id) => {
      log('Sync: registered as ' + id);
      if (id === slotA) {
        // We got slotA — wait for peer to connect
        setSyncStatus('waiting');
        log('Sync: waiting for peer on slot A');
      }
    });

    syncPeer.on('connection', (conn) => {
      log('Sync: incoming connection from ' + conn.peer);
      setupConnection(conn);
    });

    syncPeer.on('error', async (err) => {
      log('Sync: peer error: ' + err.type + ' - ' + err.message);
      if (err.type === 'unavailable-id') {
        // slotA is taken — register as slotB and connect to slotA
        log('Sync: slot A taken, trying slot B: ' + slotB);
        syncPeer.destroy();
        syncPeer = new Peer(slotB, { debug: 0 });

        syncPeer.on('open', () => {
          log('Sync: registered as slot B, connecting to slot A');
          setSyncStatus('connecting');
          const conn = syncPeer.connect(slotA, { reliable: true });
          setupConnection(conn);
        });

        syncPeer.on('connection', (conn) => {
          log('Sync: incoming connection on slot B');
          setupConnection(conn);
        });

        syncPeer.on('error', (err2) => {
          log('Sync: slot B error: ' + err2.type);
          if (err2.type !== 'peer-unavailable') {
            setSyncStatus('disconnected');
            scheduleReconnect(secret);
          }
        });

        syncPeer.on('disconnected', () => {
          log('Sync: disconnected from signaling server');
          setSyncStatus('disconnected');
          scheduleReconnect(secret);
        });
      } else if (err.type === 'peer-unavailable') {
        // Peer not online yet — stay waiting
        setSyncStatus('waiting');
      } else {
        setSyncStatus('disconnected');
        scheduleReconnect(secret);
      }
    });

    syncPeer.on('disconnected', () => {
      log('Sync: disconnected from signaling server');
      if (syncStatus === 'connected' && syncConn?.open) return; // data channel still alive
      setSyncStatus('disconnected');
      scheduleReconnect(secret);
    });

  } catch (e) {
    log('Sync: start error: ' + e.message);
    setSyncStatus('disconnected');
    scheduleReconnect(secret);
  }
}

function stopSync() {
  clearTimeout(syncReconnectTimer);
  if (syncConn) { try { syncConn.close(); } catch (e) {} syncConn = null; }
  if (syncPeer) { try { syncPeer.destroy(); } catch (e) {} syncPeer = null; }
  syncEncKey = null;
  setSyncStatus('disconnected');
  log('Sync: stopped');
}

function setupConnection(conn) {
  // Only keep one connection
  if (syncConn && syncConn !== conn && syncConn.open) {
    syncConn.close();
  }
  syncConn = conn;

  conn.on('open', async () => {
    log('Sync: data channel open with ' + conn.peer);
    setSyncStatus('connected');
    // Exchange state
    await sendSyncState(conn);
  });

  conn.on('data', async (data) => {
    try {
      const decrypted = await decryptPayload(syncEncKey, data);
      const msg = JSON.parse(decrypted);
      await handleSyncMessage(msg, conn);
    } catch (e) {
      log('Sync: decrypt/parse error: ' + e.message);
    }
  });

  conn.on('close', async () => {
    log('Sync: connection closed');
    syncConn = null;
    setSyncStatus('disconnected');
    const data = await browser.storage.local.get(['syncSecret', 'syncEnabled']);
    if (data.syncEnabled && data.syncSecret) {
      scheduleReconnect(data.syncSecret);
    }
  });

  conn.on('error', (err) => {
    log('Sync: connection error: ' + err.message);
  });
}

async function sendSyncState(conn) {
  if (!conn?.open || !syncEncKey) return;
  try {
    const state = await getFullSyncState();
    const msg = JSON.stringify({ type: 'sync-state', state });
    const encrypted = await encryptPayload(syncEncKey, msg);
    conn.send(encrypted);
    // Update last sync time
    await browser.storage.local.set({ syncLastAt: Date.now() });
    log('Sync: sent state (' + (state.hiddenUrns?.length || 0) + ' hidden, ' + (state.likedUrns?.length || 0) + ' liked)');
  } catch (e) {
    log('Sync: send error: ' + e.message);
  }
}

async function handleSyncMessage(msg, conn) {
  if (msg.type === 'sync-state' && msg.state) {
    log('Sync: received state from peer');
    await performMerge(msg.state);
    await browser.storage.local.set({ syncLastAt: Date.now() });
    broadcastSyncStatus();
    // Notify content scripts to reload
    await notifyContentScripts('syncStateUpdated');
  } else if (msg.type === 'sync-request') {
    await sendSyncState(conn);
  }
}

async function getFullSyncState() {
  const data = await browser.storage.local.get([
    'hiddenUrns', 'likedUrns', 'hiddenPosts', 'likedPosts',
    'spamFilter', 'confirmedSpamUrns'
  ]);
  return {
    hiddenUrns: data.hiddenUrns || [],
    likedUrns: data.likedUrns || [],
    hiddenPosts: data.hiddenPosts || [],
    likedPosts: data.likedPosts || [],
    spamFilter: data.spamFilter || null,
    confirmedSpamUrns: data.confirmedSpamUrns || [],
  };
}

async function performMerge(remoteState) {
  const local = await getFullSyncState();

  // Merge URN sets (union)
  const hiddenUrns = [...new Set([...local.hiddenUrns, ...(remoteState.hiddenUrns || [])])];
  const likedUrns = [...new Set([...local.likedUrns, ...(remoteState.likedUrns || [])])];
  const confirmedSpamUrns = [...new Set([...local.confirmedSpamUrns, ...(remoteState.confirmedSpamUrns || [])])];

  // Merge post arrays by URN, keep most recent, cap at 200
  const hiddenPosts = mergePostArrays(local.hiddenPosts, remoteState.hiddenPosts || []);
  const likedPosts = mergePostArrays(local.likedPosts, remoteState.likedPosts || []);

  // Merge spam filter (element-wise max of word counts)
  const spamFilter = mergeSpamFilter(local.spamFilter, remoteState.spamFilter);

  await browser.storage.local.set({
    hiddenUrns, likedUrns, hiddenPosts, likedPosts,
    spamFilter, confirmedSpamUrns,
  });

  log('Sync: merged state — ' + hiddenUrns.length + ' hidden, ' + likedUrns.length + ' liked');
}

function mergePostArrays(localPosts, remotePosts) {
  const byUrn = new Map();
  for (const p of localPosts) {
    byUrn.set(p.urn, p);
  }
  for (const p of remotePosts) {
    const existing = byUrn.get(p.urn);
    if (!existing || (p.swipedAt && (!existing.swipedAt || p.swipedAt > existing.swipedAt))) {
      byUrn.set(p.urn, p);
    }
  }
  // Sort by swipedAt descending, cap at 200
  return [...byUrn.values()]
    .sort((a, b) => (b.swipedAt || 0) - (a.swipedAt || 0))
    .slice(0, 200);
}

function mergeSpamFilter(localFilter, remoteFilter) {
  if (!remoteFilter) return localFilter;
  if (!localFilter) return remoteFilter;

  const merged = {
    spam: { ...localFilter.spam },
    ham: { ...localFilter.ham },
    spamCount: Math.max(localFilter.spamCount || 0, remoteFilter.spamCount || 0),
    hamCount: Math.max(localFilter.hamCount || 0, remoteFilter.hamCount || 0),
  };

  // Element-wise max for word counts
  for (const word in (remoteFilter.spam || {})) {
    merged.spam[word] = Math.max(merged.spam[word] || 0, remoteFilter.spam[word]);
  }
  for (const word in (remoteFilter.ham || {})) {
    merged.ham[word] = Math.max(merged.ham[word] || 0, remoteFilter.ham[word]);
  }

  return merged;
}

function setSyncStatus(status) {
  syncStatus = status;
  broadcastSyncStatus();
}

async function broadcastSyncStatus() {
  const data = await browser.storage.local.get(['syncSecret', 'syncEnabled', 'syncLastAt']);
  const statusInfo = {
    cmd: 'syncStatusUpdate',
    status: syncStatus,
    paired: !!data.syncSecret,
    enabled: !!data.syncEnabled,
    lastSyncAt: data.syncLastAt || null,
  };
  // Notify popup (it polls, but also listens)
  try {
    await browser.runtime.sendMessage(statusInfo);
  } catch (e) {
    // Popup not open
  }
}

async function notifyContentScripts(cmd) {
  try {
    const tabs = await browser.tabs.query({ url: '*://*.linkedin.com/*' });
    for (const tab of tabs) {
      try {
        await browser.tabs.sendMessage(tab.id, { cmd });
      } catch (e) {
        // Tab might not have content script loaded
      }
    }
  } catch (e) {
    // Ignore tab query errors
  }
}

function scheduleReconnect(secret) {
  clearTimeout(syncReconnectTimer);
  syncReconnectTimer = setTimeout(() => {
    log('Sync: attempting reconnect...');
    startSync(secret);
  }, 10000);
}

// ============================================
// MESSAGE HANDLER
// ============================================

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true;
});

async function handleMessage(message, sender, sendResponse) {
  switch (message.cmd) {
    case 'getStats': {
      try {
        const data = await browser.storage.local.get(['hiddenUrns', 'likedUrns']);
        sendResponse({
          hidden: (data.hiddenUrns || []).length,
          liked: (data.likedUrns || []).length,
        });
      } catch (e) {
        sendResponse({ hidden: 0, liked: 0 });
      }
      return;
    }

    case 'resetAll': {
      const syncData = await browser.storage.local.get(['syncSecret', 'syncEnabled']);
      await browser.storage.local.clear();
      // Preserve sync pairing through reset
      if (syncData.syncSecret) {
        await browser.storage.local.set({
          syncSecret: syncData.syncSecret,
          syncEnabled: syncData.syncEnabled,
        });
      }
      log('All state reset');
      await notifyContentScripts('stateReset');
      sendResponse({ ok: true });
      return;
    }

    case 'reconnectBackchannel': {
      connectBackchannel();
      sendResponse({ ok: true });
      return;
    }

    // --- Sync commands ---

    case 'syncStart': {
      const secret = message.secret;
      if (!secret) { sendResponse({ ok: false }); return; }
      await browser.storage.local.set({ syncSecret: secret, syncEnabled: true });
      await startSync(secret);
      sendResponse({ ok: true });
      return;
    }

    case 'syncStop': {
      stopSync();
      await browser.storage.local.set({ syncEnabled: false });
      sendResponse({ ok: true });
      return;
    }

    case 'syncUnpair': {
      stopSync();
      await browser.storage.local.remove(['syncSecret', 'syncEnabled', 'syncLastAt']);
      sendResponse({ ok: true });
      return;
    }

    case 'syncGetStatus': {
      const data = await browser.storage.local.get(['syncSecret', 'syncEnabled', 'syncLastAt']);
      sendResponse({
        status: syncStatus,
        paired: !!data.syncSecret,
        enabled: !!data.syncEnabled,
        lastSyncAt: data.syncLastAt || null,
      });
      return;
    }

    case 'syncTrigger': {
      if (syncConn?.open) {
        await sendSyncState(syncConn);
      }
      sendResponse({ ok: true });
      return;
    }

    case 'stateChanged': {
      // Content script saved state — push to peer if connected
      if (syncConn?.open && syncEncKey) {
        await sendSyncState(syncConn);
      }
      sendResponse({ ok: true });
      return;
    }
  }
}

// ============================================
// INIT
// ============================================

connectBackchannel();
log('Background script ready (v2)');

// Auto-restore sync on startup
(async () => {
  try {
    const data = await browser.storage.local.get(['syncSecret', 'syncEnabled']);
    if (data.syncEnabled && data.syncSecret) {
      log('Sync: auto-restoring connection...');
      await startSync(data.syncSecret);
    }
  } catch (e) {
    log('Sync: auto-restore error: ' + e.message);
  }
})();
