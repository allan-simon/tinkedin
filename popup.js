// TinkeDin Popup Script (v2)

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

loadStats();
