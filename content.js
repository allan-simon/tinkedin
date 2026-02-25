// TinkeDin - LinkedIn Feed Control (v2)
// Content Script - Per-Tab Overlay Architecture

(function() {
  'use strict';

  // ============================================
  // STATE
  // ============================================
  const state = {
    enabled: true,              // ON/OFF toggle (persisted)
    swipeMode: false,           // overlay active
    sidebarOpen: false,         // history sidebar visible
    hiddenUrns: new Set(),      // URNs swiped left - for DOM removal
    likedUrns: new Set(),       // URNs swiped right
    hiddenPosts: [],            // Full post data for sidebar [{urn, activityId, authorName, textPreview, authorImage, url, swipedAt}]
    likedPosts: [],             // Same structure
    // Session-only tinder mode state
    swipedPosts: new Set(),     // URNs already swiped this session
    tinderPosts: [],            // Queue of posts to swipe
    tinderIndex: 0,
    undoStack: [],              // For Ctrl+Z undo
    backchannelConnected: false,
  };

  // ============================================
  // BACKCHANNEL (WebSocket for external introspection)
  // ============================================
  const BACKCHANNEL_URL = 'ws://localhost:9777';
  let backchannelSocket = null;
  let backchannelReconnectTimer = null;

  function connectBackchannel() {
    if (backchannelSocket?.readyState === WebSocket.OPEN) return;

    try {
      backchannelSocket = new WebSocket(BACKCHANNEL_URL);

      backchannelSocket.onopen = () => {
        state.backchannelConnected = true;
        log('Backchannel connected');
        backchannelSocket.send(JSON.stringify({ type: 'identify', client: 'extension' }));
        sendStateToBackchannel();
      };

      backchannelSocket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleBackchannelCommand(msg);
        } catch (e) {
          console.error('[TinkeDin] Backchannel message error:', e);
        }
      };

      backchannelSocket.onclose = () => {
        state.backchannelConnected = false;
        log('Backchannel disconnected - retrying in 5s');
        backchannelReconnectTimer = setTimeout(connectBackchannel, 5000);
      };

      backchannelSocket.onerror = () => {
        console.log('[TinkeDin] Backchannel connection failed (server not running?)');
      };
    } catch (e) {
      console.log('[TinkeDin] Could not create backchannel socket:', e.message);
    }
  }

  function handleBackchannelCommand(msg) {
    // Ignore echoed logs and state updates to prevent infinite loop
    if (msg.type === 'log' || msg.type === 'stateUpdate' || msg.type === 'postDetails') {
      return;
    }

    if (msg.cmd) {
      console.log('[TinkeDin] Backchannel cmd:', msg.cmd);
    }

    switch (msg.cmd) {
      case 'getState':
        sendStateToBackchannel();
        break;
      case 'toggleEnabled':
        toggleEnabled();
        break;
      case 'setEnabled':
        setEnabled(msg.value);
        break;
      case 'openSwipeMode':
        openTinderMode();
        break;
      case 'getDOM':
        sendDOMSnapshot(msg.selector, msg.depth);
        break;
      case 'getTinderState':
        sendTinderState();
        break;
      case 'querySelector':
        sendQueryResult(msg.selector, msg.attrs);
        break;
      case 'exec':
        try {
          const result = eval(msg.code);
          backchannelSocket.send(JSON.stringify({ type: 'execResult', result: String(result) }));
        } catch (e) {
          backchannelSocket.send(JSON.stringify({ type: 'execResult', error: e.message }));
        }
        break;
    }
  }

  function sendDOMSnapshot(selector = 'body', depth = 2) {
    if (!backchannelSocket || backchannelSocket.readyState !== WebSocket.OPEN) return;

    function getElementInfo(el, currentDepth) {
      if (currentDepth > depth) return null;

      const info = {
        tag: el.tagName?.toLowerCase(),
        id: el.id || undefined,
        classes: el.className ? el.className.split(' ').filter(c => c).slice(0, 5) : undefined,
        text: el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
          ? el.textContent?.slice(0, 100) : undefined,
      };

      if (currentDepth < depth && el.children.length > 0) {
        info.children = Array.from(el.children).slice(0, 10).map(
          child => getElementInfo(child, currentDepth + 1)
        ).filter(Boolean);
        if (el.children.length > 10) {
          info.childrenTruncated = el.children.length;
        }
      }

      return info;
    }

    const root = document.querySelector(selector);
    if (!root) {
      backchannelSocket.send(JSON.stringify({ type: 'domSnapshot', error: 'Selector not found', selector }));
      return;
    }

    backchannelSocket.send(JSON.stringify({
      type: 'domSnapshot',
      selector,
      snapshot: getElementInfo(root, 0),
    }));
  }

  function sendTinderState() {
    if (!backchannelSocket || backchannelSocket.readyState !== WebSocket.OPEN) return;

    const tinderOverlay = document.getElementById('tinkedin-tinder');
    const container = document.getElementById('tinder-post-container');

    const tinderState = {
      swipeMode: state.swipeMode,
      tinderIndex: state.tinderIndex,
      tinderPostsCount: state.tinderPosts.length,
      swipedPostsCount: state.swipedPosts.size,
      undoStackSize: state.undoStack.length,
      overlayExists: !!tinderOverlay,
      containerExists: !!container,
      containerChildCount: container?.children.length || 0,
      currentPost: state.tinderPosts[state.tinderIndex] ? {
        urn: state.tinderPosts[state.tinderIndex].urn,
        activityId: state.tinderPosts[state.tinderIndex].activityId,
        alreadyKept: state.tinderPosts[state.tinderIndex].alreadyKept,
        hasElement: !!state.tinderPosts[state.tinderIndex].element,
      } : null,
    };

    backchannelSocket.send(JSON.stringify({
      type: 'tinderState',
      state: tinderState,
    }));
  }

  function sendQueryResult(selector, attrs = ['id', 'class', 'textContent']) {
    if (!backchannelSocket || backchannelSocket.readyState !== WebSocket.OPEN) return;

    const elements = document.querySelectorAll(selector);
    const results = Array.from(elements).slice(0, 20).map(el => {
      const info = { tag: el.tagName?.toLowerCase() };
      attrs.forEach(attr => {
        if (attr === 'textContent') {
          info[attr] = el.textContent?.slice(0, 200);
        } else if (attr === 'innerHTML') {
          info[attr] = el.innerHTML?.slice(0, 500);
        } else if (attr === 'outerHTML') {
          info[attr] = el.outerHTML?.slice(0, 500);
        } else {
          info[attr] = el.getAttribute?.(attr);
        }
      });
      return info;
    });

    backchannelSocket.send(JSON.stringify({
      type: 'queryResult',
      selector,
      count: elements.length,
      results,
    }));
  }

  function sendStateToBackchannel() {
    if (!backchannelSocket || backchannelSocket.readyState !== WebSocket.OPEN) return;

    backchannelSocket.send(JSON.stringify({
      type: 'stateUpdate',
      state: {
        enabled: state.enabled,
        swipeMode: state.swipeMode,
        sidebarOpen: state.sidebarOpen,
        hiddenCount: state.hiddenUrns.size,
        likedCount: state.likedUrns.size,
        tinderPostsCount: state.tinderPosts.length,
        tinderIndex: state.tinderIndex,
        url: window.location.href,
      },
    }));
  }

  function sendLogToBackchannel(msg) {
    if (!backchannelSocket || backchannelSocket.readyState !== WebSocket.OPEN) return;
    backchannelSocket.send(JSON.stringify({ type: 'log', message: msg }));
  }

  // ============================================
  // LOGGING
  // ============================================
  function log(msg) {
    console.log('[TinkeDin]', msg);
    sendLogToBackchannel(msg);
  }

  // ============================================
  // UTILITIES
  // ============================================
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================
  // FLOATING CONTROL BAR
  // ============================================
  function createControlBar() {
    if (document.getElementById('tinkedin-control-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'tinkedin-control-bar';
    bar.innerHTML = `
      <span class="td-cb-brand">TinkeDin</span>
      <label class="td-cb-toggle" title="Enable/disable hidden post removal">
        <input type="checkbox" id="td-cb-enabled" ${state.enabled ? 'checked' : ''}>
        <span class="td-cb-slider"></span>
      </label>
      <button id="td-cb-swipe" class="td-cb-btn td-cb-btn-swipe">Swipe Mode</button>
      <button id="td-cb-history" class="td-cb-btn">History</button>
      <span class="td-cb-stats">
        <span class="td-cb-stat liked" title="Liked posts">\u2665 <span id="td-cb-liked">${state.likedUrns.size}</span></span>
        <span class="td-cb-stat hidden" title="Hidden posts">\u2715 <span id="td-cb-hidden">${state.hiddenUrns.size}</span></span>
      </span>
    `;
    document.body.appendChild(bar);

    // Event listeners
    document.getElementById('td-cb-enabled').addEventListener('change', (e) => {
      setEnabled(e.target.checked);
    });
    document.getElementById('td-cb-swipe').addEventListener('click', openTinderMode);
    document.getElementById('td-cb-history').addEventListener('click', toggleSidebar);
  }

  function updateControlBar() {
    const likedEl = document.getElementById('td-cb-liked');
    const hiddenEl = document.getElementById('td-cb-hidden');
    if (likedEl) likedEl.textContent = state.likedUrns.size;
    if (hiddenEl) hiddenEl.textContent = state.hiddenUrns.size;
  }

  function setEnabled(value) {
    state.enabled = value;
    const checkbox = document.getElementById('td-cb-enabled');
    if (checkbox) checkbox.checked = value;
    saveState();
    if (value) {
      removeAllSwipedPostsFromDOM();
      log('TinkeDin enabled');
    } else {
      log('TinkeDin disabled');
    }
    sendStateToBackchannel();
  }

  function toggleEnabled() {
    setEnabled(!state.enabled);
  }

  // ============================================
  // HISTORY SIDEBAR
  // ============================================
  function createSidebar() {
    if (document.getElementById('tinkedin-sidebar')) return;

    const sidebar = document.createElement('div');
    sidebar.id = 'tinkedin-sidebar';
    sidebar.innerHTML = `
      <div class="td-sb-header">
        <span class="td-sb-title">History</span>
        <button id="td-sb-close" class="td-sb-close">\u00d7</button>
      </div>
      <div class="td-sb-content">
        <div class="td-sb-section">
          <h3 class="td-sb-section-title td-sb-liked-title">
            Liked <span id="td-sb-liked-count" class="td-sb-count">${state.likedPosts.length}</span>
          </h3>
          <div id="td-sb-liked-list" class="td-sb-list"></div>
        </div>
        <div class="td-sb-section">
          <h3 class="td-sb-section-title td-sb-hidden-title" id="td-sb-hidden-toggle">
            Hidden <span id="td-sb-hidden-count" class="td-sb-count">${state.hiddenPosts.length}</span>
            <span class="td-sb-toggle-icon">\u25bc</span>
          </h3>
          <div id="td-sb-hidden-list" class="td-sb-list td-sb-collapsed"></div>
        </div>
      </div>
    `;
    document.body.appendChild(sidebar);

    // Close button
    document.getElementById('td-sb-close').addEventListener('click', toggleSidebar);

    // Toggle hidden section
    document.getElementById('td-sb-hidden-toggle').addEventListener('click', () => {
      const list = document.getElementById('td-sb-hidden-list');
      const icon = document.querySelector('.td-sb-toggle-icon');
      list.classList.toggle('td-sb-collapsed');
      if (icon) {
        icon.style.transform = list.classList.contains('td-sb-collapsed') ? 'rotate(-90deg)' : 'rotate(0deg)';
      }
    });

    // Event delegation for undo buttons
    sidebar.addEventListener('click', (e) => {
      const undoBtn = e.target.closest('.td-sb-item-undo');
      if (undoBtn) {
        const urn = undoBtn.dataset.urn;
        const wasLiked = undoBtn.dataset.liked === 'true';
        undoSidebarPost(urn, wasLiked);
      }
    });

    updateSidebar();
  }

  function toggleSidebar() {
    state.sidebarOpen = !state.sidebarOpen;
    let sidebar = document.getElementById('tinkedin-sidebar');
    if (!sidebar) {
      createSidebar();
      sidebar = document.getElementById('tinkedin-sidebar');
    }
    sidebar.classList.toggle('td-sb-open', state.sidebarOpen);
    if (state.sidebarOpen) updateSidebar();
  }

  function updateSidebar() {
    const likedList = document.getElementById('td-sb-liked-list');
    const hiddenList = document.getElementById('td-sb-hidden-list');
    const likedCount = document.getElementById('td-sb-liked-count');
    const hiddenCount = document.getElementById('td-sb-hidden-count');

    if (!likedList) return;

    likedList.innerHTML = state.likedPosts.map(p => createSidebarItem(p, true)).join('');
    hiddenList.innerHTML = state.hiddenPosts.map(p => createSidebarItem(p, false)).join('');
    if (likedCount) likedCount.textContent = state.likedPosts.length;
    if (hiddenCount) hiddenCount.textContent = state.hiddenPosts.length;
  }

  function createSidebarItem(post, isLiked) {
    const imgSrc = post.authorImage || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23666" width="100" height="100"/></svg>';
    const textPreview = escapeHtml((post.textPreview || 'No text').slice(0, 100));
    const authorName = escapeHtml(post.authorName || 'Unknown');
    const postUrl = escapeHtml(post.url || '#');

    return `
      <div class="td-sb-item">
        <img class="td-sb-item-img" src="${imgSrc}" alt="">
        <div class="td-sb-item-content">
          <a class="td-sb-item-author" href="${postUrl}" target="_blank">${authorName}</a>
          <div class="td-sb-item-text">${textPreview}</div>
        </div>
        <button class="td-sb-item-undo" data-urn="${escapeHtml(post.urn)}" data-liked="${isLiked}" title="Undo">\u21a9</button>
      </div>
    `;
  }

  function undoSidebarPost(urn, wasLiked) {
    if (wasLiked) {
      state.likedUrns.delete(urn);
      state.likedPosts = state.likedPosts.filter(p => p.urn !== urn);
    } else {
      state.hiddenUrns.delete(urn);
      state.hiddenPosts = state.hiddenPosts.filter(p => p.urn !== urn);
    }
    saveState();
    updateControlBar();
    updateSidebar();
    log(`Undo from sidebar: ${urn.slice(-12)} (${wasLiked ? 'liked' : 'hidden'})`);
  }

  // ============================================
  // POST METADATA EXTRACTION (from DOM elements)
  // ============================================
  function extractPostMetadata(element) {
    const urn = element.getAttribute('data-urn') || '';
    const activityId = urn.replace('urn:li:activity:', '');

    // Author name - try multiple selectors (LinkedIn changes these)
    const authorName = (
      element.querySelector('.update-components-actor__name span[aria-hidden="true"]')?.textContent?.trim() ||
      element.querySelector('.update-components-actor__name')?.textContent?.trim() ||
      element.querySelector('.feed-shared-actor__name')?.textContent?.trim() ||
      'Unknown'
    );

    // Text preview
    const textPreview = (
      element.querySelector('.update-components-text')?.textContent?.trim() ||
      element.querySelector('.feed-shared-text')?.textContent?.trim() ||
      element.querySelector('.feed-shared-update-v2__description')?.textContent?.trim() ||
      ''
    ).slice(0, 200);

    // Author image
    const authorImage = (
      element.querySelector('.update-components-actor__image img')?.src ||
      element.querySelector('.feed-shared-actor__avatar img')?.src ||
      element.querySelector('.ivm-view-attr__img--centered')?.src ||
      ''
    );

    const url = `https://www.linkedin.com/feed/update/${urn}/`;

    return { urn, activityId, authorName, textPreview, authorImage, url };
  }

  // ============================================
  // TINDER MODE - Swipe through posts
  // ============================================

  // Feed loading state
  const feedState = {
    loading: false,
    seenUrns: new Set(),
    failedLoadAttempts: 0,
    maxFailedAttempts: 10,
    postObserver: null,
  };

  function createTinderUI() {
    if (document.getElementById('tinkedin-tinder')) return;

    const overlay = document.createElement('div');
    overlay.id = 'tinkedin-tinder';
    overlay.innerHTML = `
      <div class="tinder-header">
        <span class="tinder-title">TinkeDin Swipe Mode</span>
        <span class="tinder-counter"><span id="tinder-current">0</span> / <span id="tinder-total">0</span></span>
        <button id="tinder-undo" class="tinder-header-btn" title="Undo last swipe (Ctrl+Z)">\u21a9 Undo</button>
        <button id="tinder-close">\u2190 Back to LinkedIn</button>
      </div>
      <div class="tinder-content">
        <div class="tinder-post" id="tinder-post-container">
          <!-- Post content will be cloned here -->
        </div>
      </div>
      <div class="tinder-actions">
        <button class="tinder-btn tinder-remove" id="tinder-remove">
          <span class="tinder-key">\u2190</span>
          <span>Remove</span>
        </button>
        <button class="tinder-btn tinder-keep" id="tinder-keep">
          <span>Keep</span>
          <span class="tinder-key">\u2192</span>
        </button>
      </div>
      <div class="tinder-hint">Use arrow keys \u2190 \u2192 to swipe \u2022 Ctrl+Z to undo</div>
    `;
    document.body.appendChild(overlay);

    // Event listeners
    document.getElementById('tinder-close').addEventListener('click', closeTinderMode);
    document.getElementById('tinder-remove').addEventListener('click', () => tinderAction('remove'));
    document.getElementById('tinder-keep').addEventListener('click', () => tinderAction('keep'));
    document.getElementById('tinder-undo').addEventListener('click', undoLastSwipe);

    // Keyboard navigation
    document.addEventListener('keydown', tinderKeyHandler);
  }

  function tinderKeyHandler(e) {
    if (!state.swipeMode) return;

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      tinderAction('remove');
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      tinderAction('keep');
    } else if (e.key === 'Escape') {
      closeTinderMode();
    } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      undoLastSwipe();
    }
  }

  // Observer to detect new posts added to DOM during swipe mode
  function startPostObserver() {
    if (feedState.postObserver) return;

    feedState.postObserver = new MutationObserver((mutations) => {
      if (!state.swipeMode) return;

      let addedCount = 0;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          // Check if the node itself is a post
          if (node.getAttribute?.('data-urn')?.startsWith('urn:li:activity')) {
            if (addPostToQueue(node)) addedCount++;
          }

          // Check for posts inside the node
          const posts = node.querySelectorAll?.('[data-urn^="urn:li:activity"]') || [];
          posts.forEach(post => {
            if (addPostToQueue(post)) addedCount++;
          });
        }
      }

      if (addedCount > 0) {
        log(`Observer found ${addedCount} new posts`);
        updateTinderCounter();
        // Yield: if we were waiting for posts, show them immediately
        if (state.tinderIndex >= state.tinderPosts.length - addedCount) {
          showCurrentTinderPost();
        }
      }
    });

    feedState.postObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function stopPostObserver() {
    if (feedState.postObserver) {
      feedState.postObserver.disconnect();
      feedState.postObserver = null;
    }
  }

  function openTinderMode() {
    // Collect posts currently in DOM
    const domPosts = Array.from(document.querySelectorAll('[data-urn^="urn:li:activity"]'));

    if (domPosts.length === 0) {
      log('No posts found - scroll down a bit first');
      return;
    }

    state.tinderPosts = [];
    state.undoStack = [];
    feedState.seenUrns.clear();
    feedState.failedLoadAttempts = 0;

    // Add DOM posts to queue
    domPosts.forEach(post => addPostToQueue(post));

    state.tinderIndex = 0;
    state.swipeMode = true;

    const newCount = state.tinderPosts.filter(p => !p.alreadyKept).length;

    createTinderUI();
    document.body.classList.add('tinkedin-tinder-active');
    startPostObserver();
    showCurrentTinderPost();

    log(`Swipe mode started: ${state.tinderPosts.length} posts (${newCount} new)`);
  }

  function addPostToQueue(postElement) {
    const urn = postElement.getAttribute('data-urn');
    if (!urn || feedState.seenUrns.has(urn)) return false;

    // Skip already hidden posts
    if (state.hiddenUrns.has(urn)) {
      feedState.seenUrns.add(urn);
      return false;
    }

    // Auto-hide promoted posts (ads)
    const promotedSpan = Array.from(postElement.querySelectorAll('span')).find(span => {
      const text = span.textContent?.trim().toLowerCase();
      return text === 'promoted' || text === 'sponsoris\u00e9' || text === 'gesponsert' || text === 'patrocinado';
    });
    const isPromoted = promotedSpan ||
                       postElement.querySelector('[data-ad-banner]') ||
                       postElement.querySelector('.ad-banner');
    if (isPromoted) {
      feedState.seenUrns.add(urn);
      const activityId = urn.replace('urn:li:activity:', '');
      log(`Auto-hiding promoted post: ${activityId}`);
      state.hiddenUrns.add(urn);
      hidePostFromFeed(activityId);
      saveState();
      return false;
    }

    // Skip posts hidden by ad blocker
    const computedStyle = window.getComputedStyle(postElement);
    if (computedStyle.display === 'none') {
      feedState.seenUrns.add(urn);
      return false;
    }

    // Click "show more" on the ORIGINAL element before cloning
    const showMoreBtn = postElement.querySelector(
      '[data-test-id="see-more-less-toggle"], ' +
      '.feed-shared-inline-show-more-text__see-more-less-toggle, ' +
      'button[aria-label*="see more"], ' +
      'button[aria-label*="Show more"], ' +
      '.see-more'
    );
    if (showMoreBtn) {
      showMoreBtn.click();
    }

    // Clone immediately so DOM changes don't affect us
    const clonedElement = postElement.cloneNode(true);
    clonedElement.style.position = 'static';
    clonedElement.style.opacity = '1';

    feedState.seenUrns.add(urn);
    state.tinderPosts.push({
      element: clonedElement,
      originalElement: postElement,
      urn: urn,
      activityId: urn.replace('urn:li:activity:', ''),
      alreadyKept: state.swipedPosts.has(urn) || state.likedUrns.has(urn),
    });
    return true;
  }

  async function loadMorePosts() {
    if (feedState.loading) return;

    // Guard against infinite loop
    if (feedState.failedLoadAttempts >= feedState.maxFailedAttempts) {
      log(`Stopped loading: ${feedState.maxFailedAttempts} failed attempts`);
      updateTinderStatus('No more posts available');
      return;
    }

    feedState.loading = true;
    log('Loading more posts...');

    let addedCount = 0;

    // Scroll down to trigger LinkedIn loading more posts
    document.body.classList.remove('tinkedin-tinder-active');

    for (let i = 0; i < 3; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(300);
    }
    await sleep(2000);

    const domPosts = document.querySelectorAll('[data-urn^="urn:li:activity"]');

    domPosts.forEach(post => {
      if (addPostToQueue(post)) addedCount++;
    });

    log(`DOM scroll: ${domPosts.length} posts in page, added ${addedCount}`);

    window.scrollTo(0, 0);
    document.body.classList.add('tinkedin-tinder-active');

    if (addedCount > 0) {
      feedState.failedLoadAttempts = 0;
      log(`Loaded ${addedCount} new posts`);
      updateTinderCounter();
      updateTinderStatus('');
    } else {
      feedState.failedLoadAttempts++;
      log(`No new posts (attempt ${feedState.failedLoadAttempts}/${feedState.maxFailedAttempts})`);
      if (feedState.failedLoadAttempts >= feedState.maxFailedAttempts) {
        updateTinderStatus('No more posts');
      }
    }

    feedState.loading = false;
  }

  function updateTinderStatus(text) {
    const hint = document.querySelector('.tinder-hint');
    if (hint) {
      hint.textContent = text || 'Use arrow keys \u2190 \u2192 to swipe \u2022 Ctrl+Z to undo';
    }
  }

  function updateTinderCounter() {
    const currentEl = document.getElementById('tinder-current');
    const totalEl = document.getElementById('tinder-total');
    if (currentEl && totalEl) {
      const newCount = state.tinderPosts.filter(p => !p.alreadyKept).length;
      currentEl.textContent = state.tinderIndex + 1;
      totalEl.textContent = `${state.tinderPosts.length} (${newCount} new)`;
    }
  }

  function closeTinderMode() {
    state.swipeMode = false;
    document.body.classList.remove('tinkedin-tinder-active');
    stopPostObserver();

    const overlay = document.getElementById('tinkedin-tinder');
    if (overlay) overlay.remove();

    document.removeEventListener('keydown', tinderKeyHandler);

    // Remove all swiped-left posts from the DOM
    // (LinkedIn may have re-rendered elements during loadMorePosts scrolling)
    if (state.enabled) {
      removeAllSwipedPostsFromDOM();
    }

    log('Swipe mode closed');
  }

  function showCurrentTinderPost() {
    if (!state.swipeMode) return;

    // Pre-fetch: load more posts when 5 posts from the end (one-shot, no retry loop)
    if (state.tinderIndex >= state.tinderPosts.length - 5
        && !feedState.loading
        && feedState.failedLoadAttempts < feedState.maxFailedAttempts) {
      loadMorePosts().then(() => {
        if (state.swipeMode) showCurrentTinderPost();
      });
    }

    if (state.tinderIndex >= state.tinderPosts.length) {
      // Update counter so it doesn't show stale values
      updateTinderCounter();
      // Show "loading" or "done" state
      const container = document.getElementById('tinder-post-container');
      if (container) {
        if (feedState.loading) {
          container.innerHTML = `
            <div class="tinder-done">
              <div class="loader-spinner"></div>
              <div style="margin-top: 16px;">Loading more posts...</div>
            </div>
          `;
          // No retry timer - loadMorePosts().then() will refresh when done
        } else {
          container.innerHTML = `
            <div class="tinder-done">
              <div class="tinder-done-icon">\ud83c\udf89</div>
              <div>All caught up!</div>
              <div style="font-size: 16px; margin-top: 8px; color: #666;">
                ${state.tinderPosts.length} posts reviewed
              </div>
              <button id="tinder-force-load" style="margin-top: 16px; padding: 12px 24px; background: #0077b5; color: white; border: none; border-radius: 24px; cursor: pointer; font-size: 14px;">
                Load More Posts
              </button>
            </div>
          `;
          document.getElementById('tinder-force-load')?.addEventListener('click', () => {
            feedState.failedLoadAttempts = 0;
            loadMorePosts().then(() => showCurrentTinderPost());
          });
        }
      }
      return;
    }

    const post = state.tinderPosts[state.tinderIndex];
    const container = document.getElementById('tinder-post-container');

    if (!container || !post || !post.element) return;

    container.innerHTML = '';

    // Skip posts already liked/seen
    if (post.alreadyKept) {
      state.tinderIndex++;
      showCurrentTinderPost();
      return;
    }

    // Use the pre-cloned element (cloned at scan time, so it's stable)
    const displayClone = post.element.cloneNode(true);
    displayClone.style.display = 'block';
    displayClone.style.visibility = 'visible';
    displayClone.style.opacity = '1';
    container.appendChild(displayClone);

    // Fix "show more" buttons - expand truncated text
    fixShowMoreButtons(displayClone);

    // Update counter
    const newCount = state.tinderPosts.filter(p => !p.alreadyKept).length;
    document.getElementById('tinder-current').textContent = state.tinderIndex + 1;
    document.getElementById('tinder-total').textContent = `${state.tinderPosts.length} (${newCount} new)`;

  }

  function fixShowMoreButtons(container) {
    // Hide all "see more" / "show more" buttons
    const showMoreButtons = container.querySelectorAll(
      '[data-test-id="see-more-less-toggle"], ' +
      '.feed-shared-inline-show-more-text__see-more-less-toggle, ' +
      'button[aria-label*="see more"], ' +
      'button[aria-label*="Show more"], ' +
      '.see-more, ' +
      '.feed-shared-text-view__see-more'
    );
    showMoreButtons.forEach(btn => {
      btn.style.display = 'none';
    });

    // Expand all truncated text sections via CSS
    const truncatedSections = container.querySelectorAll(
      '.feed-shared-inline-show-more-text--collapsed, ' +
      '.feed-shared-text-view, ' +
      '.feed-shared-update-v2__description, ' +
      '.update-components-text, ' +
      '[class*="truncate"], ' +
      '[class*="collapsed"]'
    );

    truncatedSections.forEach(section => {
      section.classList.remove('feed-shared-inline-show-more-text--collapsed');
      section.classList.add('feed-shared-inline-show-more-text--expanded');
      section.style.maxHeight = 'none';
      section.style.overflow = 'visible';
      section.style.webkitLineClamp = 'unset';
      section.style.display = 'block';
      if (window.getComputedStyle(section).display === '-webkit-box') {
        section.style.display = 'block';
      }
    });
  }

  function tinderAction(action) {
    if (!state.swipeMode || state.tinderIndex >= state.tinderPosts.length) return;

    const post = state.tinderPosts[state.tinderIndex];
    const metadata = extractPostMetadata(post.element);

    // Mark as swiped (won't show again in tinder mode this session)
    state.swipedPosts.add(post.urn);

    if (action === 'remove') {
      state.hiddenUrns.add(post.urn);
      removePostFromDOM(post.urn);
      metadata.swipedAt = Date.now();
      state.hiddenPosts.unshift(metadata);
      if (state.hiddenPosts.length > 200) state.hiddenPosts.pop();
      log(`Removed: ${post.activityId}`);
    } else {
      state.likedUrns.add(post.urn);
      removePostFromDOM(post.urn);
      metadata.swipedAt = Date.now();
      state.likedPosts.unshift(metadata);
      if (state.likedPosts.length > 200) state.likedPosts.pop();
      log(`Liked: ${post.activityId}`);
    }

    // Push to undo stack
    state.undoStack.push({ action, post, metadata });

    // Save and update UI
    saveState();
    updateControlBar();
    if (state.sidebarOpen) updateSidebar();

    // Move to next post
    state.tinderIndex++;
    showCurrentTinderPost();
  }

  function undoLastSwipe() {
    if (state.undoStack.length === 0) {
      log('Nothing to undo');
      return;
    }

    const last = state.undoStack.pop();
    const { action, post } = last;

    // Remove from tracking
    state.swipedPosts.delete(post.urn);

    if (action === 'remove') {
      state.hiddenUrns.delete(post.urn);
      state.hiddenPosts = state.hiddenPosts.filter(p => p.urn !== post.urn);
    } else {
      state.likedUrns.delete(post.urn);
      state.likedPosts = state.likedPosts.filter(p => p.urn !== post.urn);
    }

    // Go back one step
    state.tinderIndex = Math.max(0, state.tinderIndex - 1);

    // Save and update UI
    saveState();
    updateControlBar();
    if (state.sidebarOpen) updateSidebar();
    showCurrentTinderPost();

    log(`Undo: ${post.activityId} (${action})`);
  }

  // ============================================
  // NATURAL MOUSE SIMULATION
  // ============================================

  // Simulate a natural mouse move from a random point to the target element, then click
  async function naturalClick(element) {
    const rect = element.getBoundingClientRect();
    const targetX = rect.left + rect.width * (0.3 + Math.random() * 0.4);
    const targetY = rect.top + rect.height * (0.3 + Math.random() * 0.4);

    const startX = targetX + (Math.random() - 0.5) * 400;
    const startY = targetY - 200 - Math.random() * 300;

    const cp1x = startX + (targetX - startX) * 0.3 + (Math.random() - 0.5) * 80;
    const cp1y = startY + (targetY - startY) * 0.2 + (Math.random() - 0.5) * 60;
    const cp2x = startX + (targetX - startX) * 0.7 + (Math.random() - 0.5) * 40;
    const cp2y = startY + (targetY - startY) * 0.8 + (Math.random() - 0.5) * 30;

    function bezier(t) {
      const u = 1 - t;
      return {
        x: u*u*u*startX + 3*u*u*t*cp1x + 3*u*t*t*cp2x + t*t*t*targetX,
        y: u*u*u*startY + 3*u*u*t*cp1y + 3*u*t*t*cp2y + t*t*t*targetY,
      };
    }

    const steps = 15 + Math.floor(Math.random() * 10);
    for (let i = 0; i <= steps; i++) {
      let t = i / steps;
      t = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      const pos = bezier(t);
      const jitterX = (Math.random() - 0.5) * 2;
      const jitterY = (Math.random() - 0.5) * 2;

      window.dispatchEvent(new MouseEvent('mousemove', {
        clientX: pos.x + jitterX,
        clientY: pos.y + jitterY,
        bubbles: true,
      }));

      const baseDelay = 8 + Math.random() * 12;
      const edgeSlow = (i < 3 || i > steps - 3) ? 15 : 0;
      await new Promise(r => setTimeout(r, baseDelay + edgeSlow));
    }

    element.dispatchEvent(new MouseEvent('mouseenter', { clientX: targetX, clientY: targetY, bubbles: true }));
    element.dispatchEvent(new MouseEvent('mouseover', { clientX: targetX, clientY: targetY, bubbles: true }));

    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));

    element.dispatchEvent(new MouseEvent('mousedown', { clientX: targetX, clientY: targetY, bubbles: true, button: 0 }));
    await new Promise(r => setTimeout(r, 40 + Math.random() * 60));
    element.dispatchEvent(new MouseEvent('mouseup', { clientX: targetX, clientY: targetY, bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent('click', { clientX: targetX, clientY: targetY, bubbles: true, button: 0 }));

    element.click();
  }

  // Auto-click "Show more feed updates" button when it appears
  let autoLoadPending = false;
  let autoLoadClicks = 0;
  const AUTO_LOAD_MAX_CLICKS = 3;
  let autoLoadCooldownUntil = 0;

  function tryAutoLoadMore() {
    if (autoLoadPending || !state.swipeMode) return;

    const now = Date.now();
    if (now < autoLoadCooldownUntil) return;
    if (autoLoadClicks >= AUTO_LOAD_MAX_CLICKS) {
      autoLoadCooldownUntil = now + 10 * 60 * 1000;
      autoLoadClicks = 0;
      log(`"Show more" cooldown: max ${AUTO_LOAD_MAX_CLICKS} clicks reached, pausing 10 min`);
      return;
    }

    const btn = document.querySelector('.scaffold-finite-scroll__load-button');
    if (!btn) return;

    const rect = btn.getBoundingClientRect();
    if (rect.height === 0) return;

    autoLoadPending = true;
    const delay = 1500 + Math.random() * 3000;
    log(`"Show more" button detected (${autoLoadClicks + 1}/${AUTO_LOAD_MAX_CLICKS}), clicking in ${(delay/1000).toFixed(1)}s...`);

    setTimeout(async () => {
      const freshBtn = document.querySelector('.scaffold-finite-scroll__load-button');
      if (freshBtn) {
        await naturalClick(freshBtn);
        autoLoadClicks++;
        log(`Clicked "Show more feed updates" (${autoLoadClicks}/${AUTO_LOAD_MAX_CLICKS})`);
      }
      autoLoadPending = false;
    }, delay);
  }

  // ============================================
  // SWIPED POST MANAGEMENT (hidden + liked)
  // ============================================

  function isSwipedPost(urn) {
    return state.hiddenUrns.has(urn) || state.likedUrns.has(urn);
  }

  // Observer that auto-removes swiped posts and auto-clicks "Show more" button
  function setupHiddenPostObserver() {
    const observer = new MutationObserver((mutations) => {
      if (!state.enabled) return;

      let checkLoadMore = false;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          // Skip nodes inside the tinder overlay (those are clones for display)
          if (node.closest?.('#tinkedin-tinder') || node.id === 'tinkedin-tinder') continue;

          // Check the node itself for swiped post (hidden or liked)
          const urn = node.getAttribute?.('data-urn');
          if (urn && isSwipedPost(urn)) {
            node.remove();
            log(`Auto-removed swiped post: ${urn.slice(-12)}`);
            continue;
          }

          // Check children for swiped posts
          const posts = node.querySelectorAll?.('[data-urn]');
          if (posts) {
            posts.forEach(post => {
              const postUrn = post.getAttribute('data-urn');
              if (postUrn && isSwipedPost(postUrn)) {
                post.remove();
                log(`Auto-removed swiped post (child): ${postUrn.slice(-12)}`);
              }
            });
          }

          // Check if a "Show more" button appeared
          if (node.classList?.contains('scaffold-finite-scroll__load-button') ||
              node.querySelector?.('.scaffold-finite-scroll__load-button')) {
            checkLoadMore = true;
          }
        }
      }

      if (checkLoadMore) {
        tryAutoLoadMore();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    log('Hidden post observer active');
  }

  function removePostFromDOM(urn) {
    // Remove all matching elements EXCEPT clones inside the tinder overlay
    const elements = document.querySelectorAll(`[data-urn="${urn}"]`);
    for (const el of elements) {
      if (!el.closest('#tinkedin-tinder')) {
        el.remove();
        log(`Removed from DOM: ${urn.slice(-12)}`);
      }
    }
  }

  function removeAllSwipedPostsFromDOM() {
    let count = 0;
    const allSwiped = [...state.hiddenUrns, ...state.likedUrns];
    allSwiped.forEach(urn => {
      const elements = document.querySelectorAll(`[data-urn="${urn}"]`);
      for (const el of elements) {
        if (!el.closest('#tinkedin-tinder')) {
          el.remove();
          count++;
        }
      }
    });
    if (count > 0) {
      log(`Removed ${count} hidden posts from DOM`);
    }
  }

  // Try to hide a post using LinkedIn's native hide button (for promoted posts)
  async function hidePostFromFeed(activityId) {
    const postElement = document.querySelector(`[data-urn="urn:li:activity:${activityId}"]`);
    if (!postElement) return false;

    try {
      const hideButton = postElement.querySelector('.feed-shared-control-menu__hide-post-button');
      if (hideButton) {
        hideButton.click();
        log(`Clicked native hide for: ${activityId}`);
        await new Promise(r => setTimeout(r, 300));
        return true;
      }
    } catch (e) {
      log(`Hide error: ${e.message}`);
    }
    return false;
  }

  // ============================================
  // STORAGE
  // ============================================
  async function loadState() {
    try {
      const data = await browser.storage.local.get([
        'enabled', 'hiddenUrns', 'likedUrns', 'hiddenPosts', 'likedPosts'
      ]);
      if (data.enabled !== undefined) state.enabled = data.enabled;
      if (data.hiddenUrns) state.hiddenUrns = new Set(data.hiddenUrns);
      if (data.likedUrns) state.likedUrns = new Set(data.likedUrns);
      if (data.hiddenPosts) state.hiddenPosts = data.hiddenPosts;
      if (data.likedPosts) state.likedPosts = data.likedPosts;
      log(`Loaded: ${state.hiddenUrns.size} hidden, ${state.likedUrns.size} liked, enabled=${state.enabled}`);
    } catch (e) {
      log('Storage load error: ' + e.message);
    }
  }

  async function saveState() {
    try {
      await browser.storage.local.set({
        enabled: state.enabled,
        hiddenUrns: [...state.hiddenUrns],
        likedUrns: [...state.likedUrns],
        hiddenPosts: state.hiddenPosts.slice(0, 200),
        likedPosts: state.likedPosts.slice(0, 200),
      });
    } catch (e) {
      log('Storage save error: ' + e.message);
    }
  }

  // ============================================
  // INIT
  // ============================================
  async function init() {
    console.log('[TinkeDin] Initializing v2...');

    // Wait for page to be ready
    if (document.readyState !== 'complete') {
      await new Promise(resolve => window.addEventListener('load', resolve));
    }

    await loadState();
    createControlBar();
    createSidebar();
    connectBackchannel();

    // Listen for messages from background script (e.g., resetAll broadcast)
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.cmd === 'stateReset') {
        state.hiddenUrns.clear();
        state.likedUrns.clear();
        state.hiddenPosts = [];
        state.likedPosts = [];
        state.swipedPosts.clear();
        state.undoStack = [];
        state.enabled = true;
        const checkbox = document.getElementById('td-cb-enabled');
        if (checkbox) checkbox.checked = true;
        updateControlBar();
        if (state.sidebarOpen) updateSidebar();
        log('State reset by popup');
        sendResponse({ ok: true });
      }
      return true;
    });

    // Remove hidden posts from DOM on load
    if (state.enabled) {
      removeAllSwipedPostsFromDOM();
    }

    // Start observer that auto-hides posts as they appear
    setupHiddenPostObserver();

    log('TinkeDin v2 ready!');
  }

  // Start
  init();
})();
