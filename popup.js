// TinkeDin Popup Script (v2)

// ============================================
// STATS
// ============================================

async function loadStats() {
  try {
    const stats = await browser.runtime.sendMessage({ cmd: 'getStats' });
    document.getElementById('liked-count').textContent = stats.liked || 0;
    document.getElementById('hidden-count').textContent = stats.hidden || 0;
  } catch (e) {
    console.error('Failed to load stats:', e);
  }
}

document.getElementById('linkedin-btn').addEventListener('click', () => {
  browser.tabs.create({ url: 'https://www.linkedin.com/feed/' });
  window.close();
});

document.getElementById('reset-btn').addEventListener('click', async () => {
  if (confirm('Reset all liked and hidden posts? This cannot be undone.')) {
    await browser.runtime.sendMessage({ cmd: 'resetAll' });
    loadStats();
  }
});

// ============================================
// SYNC UI
// ============================================

const syncDot = document.getElementById('sync-dot');
const syncStatusText = document.getElementById('sync-status-text');
const syncPairBtn = document.getElementById('sync-pair-btn');
const syncNowBtn = document.getElementById('sync-now-btn');
const syncUnpairBtn = document.getElementById('sync-unpair-btn');
const syncQrContainer = document.getElementById('sync-qr-container');
const syncQrCanvas = document.getElementById('sync-qr-canvas');
const syncLastEl = document.getElementById('sync-last');

function generateSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function updateSyncUI(info) {
  const { status, paired, lastSyncAt } = info;

  // Status dot
  syncDot.className = 'sync-dot ' + status;

  // Status text
  const labels = {
    disconnected: 'Disconnected',
    connecting: 'Connecting...',
    waiting: 'Waiting for peer...',
    connected: 'Connected',
  };
  syncStatusText.textContent = labels[status] || status;

  // Buttons
  if (paired) {
    syncPairBtn.textContent = status === 'disconnected' ? 'Reconnect' : 'Pair Device';
    syncPairBtn.classList.toggle('hidden', status === 'connected' || status === 'waiting' || status === 'connecting');
    syncNowBtn.classList.toggle('hidden', status !== 'connected');
    syncUnpairBtn.classList.remove('hidden');
  } else {
    syncPairBtn.textContent = 'Pair Device';
    syncPairBtn.classList.remove('hidden');
    syncNowBtn.classList.add('hidden');
    syncUnpairBtn.classList.add('hidden');
    syncQrContainer.classList.add('hidden');
  }

  // Last sync time
  if (lastSyncAt) {
    const ago = formatTimeAgo(lastSyncAt);
    syncLastEl.textContent = 'Last sync: ' + ago;
    syncLastEl.classList.remove('hidden');
  } else {
    syncLastEl.classList.add('hidden');
  }
}

function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

function showPairingQR(secret) {
  syncQrCanvas.innerHTML = '';
  const url = 'https://www.linkedin.com/feed#tinkedin-pair=' + secret;
  try {
    const canvas = QRCode.toCanvas(url, { scale: 5, margin: 3 });
    syncQrCanvas.appendChild(canvas);
    syncQrContainer.classList.remove('hidden');
  } catch (e) {
    console.error('QR generation failed:', e);
    syncQrContainer.classList.add('hidden');
  }
}

// Pair button
syncPairBtn.addEventListener('click', async () => {
  // Check if already paired (reconnect case)
  const status = await browser.runtime.sendMessage({ cmd: 'syncGetStatus' });
  let secret;
  if (status.paired) {
    // Reconnect with existing secret
    const data = await browser.storage.local.get('syncSecret');
    secret = data.syncSecret;
    if (!secret) return;
    showPairingQR(secret);
  } else {
    // Generate new secret
    secret = generateSecret();
    showPairingQR(secret);
  }
  await browser.runtime.sendMessage({ cmd: 'syncStart', secret });
});

// Sync now button
syncNowBtn.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ cmd: 'syncTrigger' });
  syncNowBtn.textContent = 'Syncing...';
  setTimeout(() => { syncNowBtn.textContent = 'Sync Now'; }, 1500);
});

// Unpair button
syncUnpairBtn.addEventListener('click', async () => {
  if (confirm('Unpair this device? You will need to scan a new QR code to pair again.')) {
    await browser.runtime.sendMessage({ cmd: 'syncUnpair' });
    syncQrContainer.classList.add('hidden');
    updateSyncUI({ status: 'disconnected', paired: false, lastSyncAt: null });
  }
});

// Listen for status updates from background
browser.runtime.onMessage.addListener((message) => {
  if (message.cmd === 'syncStatusUpdate') {
    updateSyncUI(message);
  }
});

// ============================================
// INIT
// ============================================

async function initPopup() {
  loadStats();

  // Load sync status
  try {
    const syncInfo = await browser.runtime.sendMessage({ cmd: 'syncGetStatus' });
    updateSyncUI(syncInfo);
  } catch (e) {
    updateSyncUI({ status: 'disconnected', paired: false, lastSyncAt: null });
  }
}

initPopup();
