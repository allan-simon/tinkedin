// TinkeDin Background Script (v2)
// Minimal: backchannel WebSocket + storage queries

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

// Message handler
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
      await browser.storage.local.clear();
      log('All state reset');
      // Notify content scripts to reload state
      try {
        const tabs = await browser.tabs.query({ url: '*://*.linkedin.com/*' });
        for (const tab of tabs) {
          try {
            await browser.tabs.sendMessage(tab.id, { cmd: 'stateReset' });
          } catch (e) {
            // Tab might not have content script loaded
          }
        }
      } catch (e) {
        // Ignore tab query errors
      }
      sendResponse({ ok: true });
      return;
    }

    case 'reconnectBackchannel': {
      connectBackchannel();
      sendResponse({ ok: true });
      return;
    }
  }
}

// Initialize
connectBackchannel();
log('Background script ready (v2)');
