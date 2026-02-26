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
    // Spam filter
    spamFilter: { spam: {}, ham: {}, spamCount: 0, hamCount: 0 },
    spamReviewMode: false,
    confirmedSpamUrns: new Set(),
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
        backchannelSocket.send(JSON.stringify({ type: 'execResult', error: 'exec disabled for AMO compliance' }));
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
  // SPAM FILTER (Naive Bayes Classifier)
  // ============================================
  const SPAM_THRESHOLD = 0.7;
  const SPAM_SMOOTHING = 1; // Laplace smoothing

  const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
    'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their',
    'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
    'not', 'no', 'nor', 'if', 'then', 'so', 'as', 'just', 'very',
    'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou',
    'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles',
    'est', 'sont', 'ont', 'dans', 'sur', 'pour', 'avec', 'par',
    'que', 'qui', 'ne', 'pas', 'plus', 'ce', 'se', 'en', 'au', 'aux',
  ]);

  function tokenize(text) {
    if (!text) return [];
    const cleaned = text.toLowerCase()
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[^\w\s\u00C0-\u024F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const words = cleaned.split(' ').filter(w => w.length > 1 && !STOPWORDS.has(w));

    const bigrams = [];
    for (let i = 0; i < words.length - 1; i++) {
      bigrams.push(words[i] + '_' + words[i + 1]);
    }

    return [...words, ...bigrams];
  }

  function trainSpam(tokens) {
    tokens.forEach(token => {
      state.spamFilter.spam[token] = (state.spamFilter.spam[token] || 0) + 1;
    });
    state.spamFilter.spamCount++;
  }

  function trainHam(tokens) {
    tokens.forEach(token => {
      state.spamFilter.ham[token] = (state.spamFilter.ham[token] || 0) + 1;
    });
    state.spamFilter.hamCount++;
  }

  function scorePost(tokens) {
    const { spam, ham, spamCount, hamCount } = state.spamFilter;
    const totalCount = spamCount + hamCount;
    if (totalCount === 0) return 0;

    const pSpam = spamCount / totalCount;
    const pHam = hamCount / totalCount;

    const vocab = new Set([...Object.keys(spam), ...Object.keys(ham)]);
    const vocabSize = vocab.size || 1;

    const totalSpamWords = Object.values(spam).reduce((a, b) => a + b, 0) + vocabSize * SPAM_SMOOTHING;
    const totalHamWords = Object.values(ham).reduce((a, b) => a + b, 0) + vocabSize * SPAM_SMOOTHING;

    let logSpam = Math.log(pSpam);
    let logHam = Math.log(pHam);

    const relevantTokens = tokens.filter(t => spam[t] || ham[t]);
    if (relevantTokens.length === 0) return pSpam;

    for (const token of relevantTokens) {
      const spamFreq = (spam[token] || 0) + SPAM_SMOOTHING;
      const hamFreq = (ham[token] || 0) + SPAM_SMOOTHING;

      logSpam += Math.log(spamFreq / totalSpamWords);
      logHam += Math.log(hamFreq / totalHamWords);
    }

    // Log-sum-exp trick for numerical stability
    const maxLog = Math.max(logSpam, logHam);
    const expSpam = Math.exp(logSpam - maxLog);
    const expHam = Math.exp(logHam - maxLog);

    return expSpam / (expSpam + expHam);
  }

  function classifyPost(postEntry) {
    const text = postEntry.element?.textContent || '';
    const tokens = tokenize(text);
    postEntry.spamScore = scorePost(tokens);
    postEntry.spamTokens = tokens;
    postEntry.isSpam = postEntry.spamScore >= SPAM_THRESHOLD;
    return postEntry.isSpam;
  }

  function seedSpamFilter() {
    if (state.spamFilter.spamCount > 0 || state.spamFilter.hamCount > 0) return;

    const spamSeeds = [
      'diplôme certifié certification obtenu formation badge credential passed exam certified proud completing',
      'nouveau poste nouvelle aventure ravi annoncer joined excited share new role new chapter thrilled announce',
      'event soirée meetup conférence salon afterwork networking inscription register webinar summit',
      'match équipe victoire élection vote politique coupe champion mondial tournament playoff',
      'growth funnel conversion leads seo content strategy engagement branding audience marketing hack',
      'prospection cold call pipeline closing outbound sdr bdr deal quota revenue sales prospect',
    ];

    spamSeeds.forEach(seedText => {
      const tokens = tokenize(seedText);
      tokens.forEach(token => {
        state.spamFilter.spam[token] = (state.spamFilter.spam[token] || 0) + 1;
      });
      state.spamFilter.spamCount++;
    });

    const hamSeeds = [
      'software engineering architecture design patterns code review technical implementation',
      'interesting article research paper findings data analysis results methodology',
      'project update team collaboration open source contribution github pull request',
      'great insight learned experience working building product development',
    ];

    hamSeeds.forEach(seedText => {
      const tokens = tokenize(seedText);
      tokens.forEach(token => {
        state.spamFilter.ham[token] = (state.spamFilter.ham[token] || 0) + 1;
      });
      state.spamFilter.hamCount++;
    });

    log(`Spam filter seeded: ${Object.keys(state.spamFilter.spam).length} spam tokens, ${Object.keys(state.spamFilter.ham).length} ham tokens`);
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
        <input type="checkbox" id="td-cb-enabled">
        <span class="td-cb-slider"></span>
      </label>
      <button id="td-cb-swipe" class="td-cb-btn td-cb-btn-swipe">Swipe Mode</button>
      <button id="td-cb-history" class="td-cb-btn">History</button>
      <button id="td-cb-spam" class="td-cb-btn td-cb-btn-spam">Spam <span id="td-cb-spam-count">0</span></button>
      <span class="td-cb-stats">
        <span class="td-cb-stat liked" title="Liked posts">\u2665 <span id="td-cb-liked">0</span></span>
        <span class="td-cb-stat hidden" title="Hidden posts">\u2715 <span id="td-cb-hidden">0</span></span>
      </span>
    `;
    document.body.appendChild(bar);
    bar.querySelector('#td-cb-enabled').checked = state.enabled;
    bar.querySelector('#td-cb-liked').textContent = state.likedUrns.size;
    bar.querySelector('#td-cb-hidden').textContent = state.hiddenUrns.size;

    // Event listeners
    document.getElementById('td-cb-enabled').addEventListener('change', (e) => {
      setEnabled(e.target.checked);
    });
    document.getElementById('td-cb-swipe').addEventListener('click', openTinderMode);
    document.getElementById('td-cb-history').addEventListener('click', toggleSidebar);
    document.getElementById('td-cb-spam').addEventListener('click', openSpamReviewMode);

    // On mobile: brand label toggles collapse/expand
    bar.querySelector('.td-cb-brand').addEventListener('click', () => {
      bar.classList.toggle('td-cb-collapsed');
    });
    // Start collapsed on mobile
    if (window.innerWidth <= 600) {
      bar.classList.add('td-cb-collapsed');
    }
  }

  function updateControlBar() {
    const likedEl = document.getElementById('td-cb-liked');
    const hiddenEl = document.getElementById('td-cb-hidden');
    if (likedEl) likedEl.textContent = state.likedUrns.size;
    if (hiddenEl) hiddenEl.textContent = state.hiddenUrns.size;
    updateSpamButton();
  }

  function updateSpamButton() {
    const countEl = document.getElementById('td-cb-spam-count');
    if (countEl) {
      const spamCount = state.tinderPosts.filter(p => p.isSpam && !p.alreadyKept).length;
      countEl.textContent = spamCount;
    }
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
            Liked <span id="td-sb-liked-count" class="td-sb-count">0</span>
          </h3>
          <div id="td-sb-liked-list" class="td-sb-list"></div>
        </div>
        <div class="td-sb-section">
          <h3 class="td-sb-section-title td-sb-hidden-title" id="td-sb-hidden-toggle">
            Hidden <span id="td-sb-hidden-count" class="td-sb-count">0</span>
            <span class="td-sb-toggle-icon">\u25bc</span>
          </h3>
          <div id="td-sb-hidden-list" class="td-sb-list td-sb-collapsed"></div>
        </div>
      </div>
    `;
    document.body.appendChild(sidebar);
    sidebar.querySelector('#td-sb-liked-count').textContent = state.likedPosts.length;
    sidebar.querySelector('#td-sb-hidden-count').textContent = state.hiddenPosts.length;

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

    likedList.replaceChildren(...state.likedPosts.map(p => createSidebarItem(p, true)));
    hiddenList.replaceChildren(...state.hiddenPosts.map(p => createSidebarItem(p, false)));
    if (likedCount) likedCount.textContent = state.likedPosts.length;
    if (hiddenCount) hiddenCount.textContent = state.hiddenPosts.length;
  }

  function createSidebarItem(post, isLiked) {
    const item = document.createElement('div');
    item.className = 'td-sb-item';

    const img = document.createElement('img');
    img.className = 'td-sb-item-img';
    img.src = post.authorImage || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23666" width="100" height="100"/></svg>';
    img.alt = '';

    const content = document.createElement('div');
    content.className = 'td-sb-item-content';

    const author = document.createElement('a');
    author.className = 'td-sb-item-author';
    author.href = post.url || '#';
    author.target = '_blank';
    author.textContent = post.authorName || 'Unknown';

    const text = document.createElement('div');
    text.className = 'td-sb-item-text';
    text.textContent = (post.textPreview || 'No text').slice(0, 100);

    content.appendChild(author);
    content.appendChild(text);

    const undo = document.createElement('button');
    undo.className = 'td-sb-item-undo';
    undo.dataset.urn = post.urn;
    undo.dataset.liked = String(isLiked);
    undo.title = 'Undo';
    undo.textContent = '\u21a9';

    item.appendChild(img);
    item.appendChild(content);
    item.appendChild(undo);
    return item;
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
    const urn = getPostUrn(element) || element.getAttribute('data-urn') || '';
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
  // POST DISCOVERY (supports old and new LinkedIn DOM)
  // ============================================

  // Extract URN + sponsored flag from LinkedIn's new tracking scope attribute
  // New LinkedIn encodes post data as a byte array inside data-view-tracking-scope JSON
  function extractTrackingData(element) {
    const scope = element.getAttribute('data-view-tracking-scope');
    if (!scope) return null;
    try {
      const json = JSON.parse(scope);
      const breadcrumb = json?.[0]?.breadcrumb;
      if (!breadcrumb?.content?.data) return null;
      const decoded = breadcrumb.content.data.map(b => String.fromCharCode(b)).join('');
      const inner = JSON.parse(decoded);
      if (inner.updateUrn) {
        return { urn: inner.updateUrn, isSponsored: !!inner.isSponsored };
      }
    } catch (e) { /* invalid tracking data */ }
    return null;
  }

  // Get URN from a post element (old data-urn or new tracking scope)
  // Stamps element with data-td-urn for easy lookup later
  function getPostUrn(element) {
    const dataUrn = element.getAttribute('data-urn');
    if (dataUrn?.startsWith('urn:li:activity:')) return dataUrn;

    const stamped = element.getAttribute('data-td-urn');
    if (stamped) return stamped;

    const tracking = extractTrackingData(element);
    if (tracking?.urn) {
      element.setAttribute('data-td-urn', tracking.urn);
      return tracking.urn;
    }
    return null;
  }

  // Check if element is a sponsored post via tracking data
  function isTrackingSponsored(element) {
    const tracking = extractTrackingData(element);
    return tracking?.isSponsored || false;
  }

  // Find all feed post elements in the current DOM
  function findFeedPosts() {
    // Old LinkedIn: data-urn attribute
    let posts = Array.from(document.querySelectorAll('[data-urn^="urn:li:activity"]'));
    if (posts.length > 0) return posts;

    // New LinkedIn: tracking scope with feed update data
    const tracked = document.querySelectorAll('[data-view-tracking-scope]');
    posts = Array.from(tracked).filter(el => {
      const tracking = extractTrackingData(el);
      if (tracking?.urn) {
        el.setAttribute('data-td-urn', tracking.urn);
        return true;
      }
      return false;
    });

    if (posts.length > 0) {
      log(`Found ${posts.length} posts via tracking scope (new LinkedIn DOM)`);
    }
    return posts;
  }

  // Find post elements in DOM by URN (for removal)
  function findPostElementsByUrn(urn) {
    const oldMatches = document.querySelectorAll(`[data-urn="${urn}"]`);
    if (oldMatches.length > 0) return Array.from(oldMatches);
    return Array.from(document.querySelectorAll(`[data-td-urn="${urn}"]`));
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

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'className') e.className = v;
        else if (k === 'textContent') e.textContent = v;
        else e.setAttribute(k, v);
      }
    }
    for (const c of children) {
      e.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function createTinderUI() {
    if (document.getElementById('tinkedin-tinder')) return;

    const overlay = el('div', { id: 'tinkedin-tinder' },
      el('div', { className: 'tinder-header' },
        el('span', { className: 'tinder-title', textContent: 'TinkeDin Swipe Mode' }),
        el('span', { className: 'tinder-counter' },
          el('span', { id: 'tinder-current', textContent: '0' }),
          ' / ',
          el('span', { id: 'tinder-total', textContent: '0' }),
        ),
        el('button', { id: 'tinder-undo', className: 'tinder-header-btn', title: 'Undo last swipe (Ctrl+Z)', textContent: '\u21a9 Undo' }),
        el('button', { id: 'tinder-mode-toggle', className: 'tinder-header-btn', textContent: 'Spam (0)' }),
        el('button', { id: 'tinder-close', textContent: '\u2190 Back to LinkedIn' }),
      ),
      el('div', { className: 'tinder-content' },
        el('div', { className: 'tinder-post', id: 'tinder-post-container' }),
      ),
      el('div', { className: 'tinder-actions' },
        el('button', { className: 'tinder-btn tinder-remove', id: 'tinder-remove' },
          el('span', { className: 'tinder-key', textContent: '\u2190' }),
          el('span', { textContent: 'Remove' }),
        ),
        el('button', { className: 'tinder-btn tinder-keep', id: 'tinder-keep' },
          el('span', { textContent: 'Keep' }),
          el('span', { className: 'tinder-key', textContent: '\u2192' }),
        ),
      ),
      el('div', {
        className: 'tinder-hint',
        textContent: 'ontouchstart' in window
          ? 'Swipe or use arrow keys \u2190 \u2192 \u2022 Ctrl+Z to undo'
          : 'Use arrow keys \u2190 \u2192 to swipe \u2022 Ctrl+Z to undo',
      }),
    );
    document.body.appendChild(overlay);

    // Event listeners
    overlay.querySelector('#tinder-close').addEventListener('click', closeTinderMode);
    overlay.querySelector('#tinder-remove').addEventListener('click', () => tinderAction('remove'));
    overlay.querySelector('#tinder-keep').addEventListener('click', () => tinderAction('keep'));
    overlay.querySelector('#tinder-undo').addEventListener('click', undoLastSwipe);
    overlay.querySelector('#tinder-mode-toggle').addEventListener('click', toggleSwipeSpamMode);

    // Keyboard navigation
    document.addEventListener('keydown', tinderKeyHandler);

    // Touch swipe gestures
    const contentArea = overlay.querySelector('.tinder-content');
    contentArea.addEventListener('touchstart', tinderTouchStart, { passive: true });
    contentArea.addEventListener('touchmove', tinderTouchMove, { passive: false });
    contentArea.addEventListener('touchend', tinderTouchEnd, { passive: true });
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

  // Touch swipe handling
  let touchStartX = 0;
  let touchStartY = 0;
  let touchDeltaX = 0;
  let isSwiping = false;

  function tinderTouchStart(e) {
    if (!state.swipeMode) return;
    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchDeltaX = 0;
    isSwiping = false;
  }

  function tinderTouchMove(e) {
    if (!state.swipeMode) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;

    // Lock into horizontal swipe once horizontal movement exceeds vertical
    if (!isSwiping && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      isSwiping = true;
    }

    if (!isSwiping) return;
    e.preventDefault();

    touchDeltaX = dx;
    const container = document.getElementById('tinder-post-container');
    if (container) {
      const rotation = dx * 0.05;
      container.style.transition = 'none';
      container.style.transform = `translateX(${dx}px) rotate(${rotation}deg)`;
      container.style.opacity = Math.max(0.5, 1 - Math.abs(dx) / 400);
    }
  }

  function tinderTouchEnd() {
    if (!state.swipeMode || !isSwiping) return;

    const container = document.getElementById('tinder-post-container');
    const SWIPE_THRESHOLD = 80;

    if (Math.abs(touchDeltaX) > SWIPE_THRESHOLD) {
      // Animate card off screen, then trigger action
      if (container) {
        const direction = touchDeltaX > 0 ? 1 : -1;
        container.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
        container.style.transform = `translateX(${direction * 500}px) rotate(${direction * 20}deg)`;
        container.style.opacity = '0';
      }
      const action = touchDeltaX > 0 ? 'keep' : 'remove';
      setTimeout(() => tinderAction(action), 250);
    } else {
      // Snap back
      if (container) {
        container.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
        container.style.transform = '';
        container.style.opacity = '';
      }
    }

    touchDeltaX = 0;
    isSwiping = false;
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
          if (getPostUrn(node)) {
            if (addPostToQueue(node)) addedCount++;
          }

          // Check for posts inside the node (old and new selectors)
          const posts = node.querySelectorAll?.('[data-urn^="urn:li:activity"], [data-view-tracking-scope]') || [];
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
    const domPosts = findFeedPosts();

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
    state.spamReviewMode = false;

    const newCount = state.tinderPosts.filter(p => !p.alreadyKept).length;
    const spamCount = state.tinderPosts.filter(p => p.isSpam && !p.alreadyKept).length;

    createTinderUI();
    document.body.classList.add('tinkedin-tinder-active');
    startPostObserver();
    showCurrentTinderPost();
    updateSpamButton();

    log(`Swipe mode started: ${state.tinderPosts.length} posts (${newCount} new, ${spamCount} spam)`);
  }

  function addPostToQueue(postElement) {
    const urn = getPostUrn(postElement);
    if (!urn || feedState.seenUrns.has(urn)) return false;

    // Skip already hidden posts
    if (state.hiddenUrns.has(urn)) {
      feedState.seenUrns.add(urn);
      return false;
    }

    // Skip confirmed spam posts
    if (state.confirmedSpamUrns.has(urn)) {
      feedState.seenUrns.add(urn);
      return false;
    }

    // Auto-hide promoted posts (ads) - check tracking data first, then DOM
    const sponsoredByTracking = isTrackingSponsored(postElement);
    const promotedSpan = !sponsoredByTracking && Array.from(postElement.querySelectorAll('span')).find(span => {
      const text = span.textContent?.trim().toLowerCase();
      return text === 'promoted' || text === 'sponsorisé' || text === 'gesponsert' || text === 'patrocinado';
    });
    const isPromoted = sponsoredByTracking || promotedSpan ||
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
    const postEntry = {
      element: clonedElement,
      originalElement: postElement,
      urn: urn,
      activityId: urn.replace('urn:li:activity:', ''),
      alreadyKept: state.swipedPosts.has(urn) || state.likedUrns.has(urn),
    };

    // Classify for spam
    classifyPost(postEntry);

    state.tinderPosts.push(postEntry);
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

    const domPosts = findFeedPosts();

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
      hint.textContent = text || ('ontouchstart' in window ? 'Swipe or use arrow keys \u2190 \u2192 \u2022 Ctrl+Z to undo' : 'Use arrow keys \u2190 \u2192 to swipe \u2022 Ctrl+Z to undo');
    }
  }

  function updateTinderCounter() {
    const currentEl = document.getElementById('tinder-current');
    const totalEl = document.getElementById('tinder-total');
    if (currentEl && totalEl) {
      const newCount = state.tinderPosts.filter(p => !p.alreadyKept).length;
      const spamCount = state.tinderPosts.filter(p => p.isSpam && !p.alreadyKept).length;
      currentEl.textContent = state.tinderIndex + 1;
      const parts = [`${newCount} new`];
      if (spamCount > 0) parts.push(`${spamCount} spam`);
      totalEl.textContent = `${state.tinderPosts.length} (${parts.join(', ')})`;
    }
    updateModeToggle();
  }

  function updateModeToggle() {
    const btn = document.getElementById('tinder-mode-toggle');
    if (!btn) return;
    if (state.spamReviewMode) {
      const normalCount = state.tinderPosts.filter(p => !p.isSpam && !p.alreadyKept).length;
      btn.textContent = `Normal (${normalCount})`;
    } else {
      const spamCount = state.tinderPosts.filter(p => p.isSpam && !p.alreadyKept).length;
      btn.textContent = `Spam (${spamCount})`;
    }
  }

  function toggleSwipeSpamMode() {
    state.spamReviewMode = !state.spamReviewMode;

    const headerEl = document.querySelector('.tinder-header');
    const titleEl = document.querySelector('.tinder-title');
    const removeBtn = document.getElementById('tinder-remove');
    const keepBtn = document.getElementById('tinder-keep');

    if (state.spamReviewMode) {
      if (headerEl) headerEl.classList.add('td-spam-review-header');
      if (titleEl) titleEl.textContent = 'TinkeDin Spam Review';
      if (removeBtn) {
        removeBtn.replaceChildren(
          el('span', { className: 'tinder-key', textContent: '\u2190' }),
          el('span', { textContent: 'Confirm Spam' }),
        );
      }
      if (keepBtn) {
        keepBtn.replaceChildren(
          el('span', { textContent: 'Not Spam' }),
          el('span', { className: 'tinder-key', textContent: '\u2192' }),
        );
      }
    } else {
      if (headerEl) headerEl.classList.remove('td-spam-review-header');
      if (titleEl) titleEl.textContent = 'TinkeDin Swipe Mode';
      if (removeBtn) {
        removeBtn.replaceChildren(
          el('span', { className: 'tinder-key', textContent: '\u2190' }),
          el('span', { textContent: 'Remove' }),
        );
      }
      if (keepBtn) {
        keepBtn.replaceChildren(
          el('span', { textContent: 'Keep' }),
          el('span', { className: 'tinder-key', textContent: '\u2192' }),
        );
      }
    }

    state.tinderIndex = 0;
    showCurrentTinderPost();
    log(`Switched to ${state.spamReviewMode ? 'spam review' : 'normal swipe'} mode`);
  }

  function closeTinderMode() {
    state.swipeMode = false;
    state.spamReviewMode = false;
    document.body.classList.remove('tinkedin-tinder-active');
    stopPostObserver();

    const overlay = document.getElementById('tinkedin-tinder');
    if (overlay) {
      const contentArea = overlay.querySelector('.tinder-content');
      if (contentArea) {
        contentArea.removeEventListener('touchstart', tinderTouchStart);
        contentArea.removeEventListener('touchmove', tinderTouchMove);
        contentArea.removeEventListener('touchend', tinderTouchEnd);
      }
      overlay.remove();
    }

    document.removeEventListener('keydown', tinderKeyHandler);

    // Remove all swiped-left posts from the DOM
    // (LinkedIn may have re-rendered elements during loadMorePosts scrolling)
    if (state.enabled) {
      removeAllSwipedPostsFromDOM();
    }

    log('Swipe mode closed');
  }

  function openSpamReviewMode() {
    // If overlay is already open, just toggle to spam mode
    if (state.swipeMode) {
      if (!state.spamReviewMode) toggleSwipeSpamMode();
      return;
    }

    const domPosts = findFeedPosts();

    if (domPosts.length === 0) {
      log('No posts found - scroll down a bit first');
      return;
    }

    state.tinderPosts = [];
    state.undoStack = [];
    feedState.seenUrns.clear();
    feedState.failedLoadAttempts = 0;

    domPosts.forEach(post => addPostToQueue(post));

    const spamCount = state.tinderPosts.filter(p => p.isSpam && !p.alreadyKept).length;

    if (spamCount === 0) {
      log('No spam posts to review');
      return;
    }

    state.tinderIndex = 0;
    state.swipeMode = true;
    state.spamReviewMode = true;

    createTinderUI();

    // Customize UI for spam review mode
    const titleEl = document.querySelector('.tinder-title');
    if (titleEl) titleEl.textContent = 'TinkeDin Spam Review';
    const headerEl = document.querySelector('.tinder-header');
    if (headerEl) headerEl.classList.add('td-spam-review-header');
    const removeBtn = document.getElementById('tinder-remove');
    if (removeBtn) {
      removeBtn.replaceChildren(
        el('span', { className: 'tinder-key', textContent: '\u2190' }),
        el('span', { textContent: 'Confirm Spam' }),
      );
    }
    const keepBtn = document.getElementById('tinder-keep');
    if (keepBtn) {
      keepBtn.replaceChildren(
        el('span', { textContent: 'Not Spam' }),
        el('span', { className: 'tinder-key', textContent: '\u2192' }),
      );
    }

    document.body.classList.add('tinkedin-tinder-active');
    startPostObserver();
    showCurrentTinderPost();

    log(`Spam review mode started: ${spamCount} spam posts to review`);
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
              <div id="tinder-done-count" style="font-size: 16px; margin-top: 8px; color: #666;"></div>
              <button id="tinder-force-load" style="margin-top: 16px; padding: 12px 24px; background: #0077b5; color: white; border: none; border-radius: 24px; cursor: pointer; font-size: 14px;">
                Load More Posts
              </button>
            </div>
          `;
          document.getElementById('tinder-done-count').textContent = state.tinderPosts.length + ' posts reviewed';
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

    // In normal mode, skip spam-flagged posts (they go to spam review)
    if (!state.spamReviewMode && post.isSpam) {
      state.tinderIndex++;
      showCurrentTinderPost();
      return;
    }

    // In spam review mode, skip non-spam posts
    if (state.spamReviewMode && !post.isSpam) {
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

    // Show spam score badge if post has a score
    if (post.spamScore > 0) {
      const badge = document.createElement('div');
      badge.className = 'td-spam-badge';
      badge.textContent = `Spam: ${Math.round(post.spamScore * 100)}%`;
      container.insertBefore(badge, container.firstChild);
    }

    // Fix "show more" buttons - expand truncated text
    fixShowMoreButtons(displayClone);

    // Update counter
    updateTinderCounter();

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

    // Spam review mode has its own handler
    if (state.spamReviewMode) {
      tinderSpamAction(action, post);
      return;
    }

    const metadata = extractPostMetadata(post.element);

    // Mark as swiped (won't show again in tinder mode this session)
    state.swipedPosts.add(post.urn);

    if (action === 'remove') {
      state.hiddenUrns.add(post.urn);
      removePostFromDOM(post.urn);
      metadata.swipedAt = Date.now();
      state.hiddenPosts.unshift(metadata);
      if (state.hiddenPosts.length > 200) state.hiddenPosts.pop();
      // Train spam filter: removed = more spam-like
      if (post.spamTokens) trainSpam(post.spamTokens);
      log(`Removed: ${post.activityId}`);
    } else {
      state.likedUrns.add(post.urn);
      removePostFromDOM(post.urn);
      metadata.swipedAt = Date.now();
      state.likedPosts.unshift(metadata);
      if (state.likedPosts.length > 200) state.likedPosts.pop();
      // Train spam filter: liked = ham
      if (post.spamTokens) trainHam(post.spamTokens);
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

  function tinderSpamAction(action, post) {
    const metadata = extractPostMetadata(post.element);
    state.swipedPosts.add(post.urn);

    if (action === 'remove') {
      // Confirm spam: train filter + hide
      if (post.spamTokens) trainSpam(post.spamTokens);
      state.confirmedSpamUrns.add(post.urn);
      state.hiddenUrns.add(post.urn);
      removePostFromDOM(post.urn);
      metadata.swipedAt = Date.now();
      state.hiddenPosts.unshift(metadata);
      if (state.hiddenPosts.length > 200) state.hiddenPosts.pop();
      log(`Confirmed spam: ${post.activityId}`);
    } else {
      // Not spam: train ham + unflag
      if (post.spamTokens) trainHam(post.spamTokens);
      post.isSpam = false;
      log(`Not spam: ${post.activityId}`);
    }

    state.undoStack.push({ action, post, metadata, spamReview: true });

    saveState();
    updateControlBar();
    if (state.sidebarOpen) updateSidebar();

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

    if (last.spamReview) {
      // Undo spam review action
      if (action === 'remove') {
        // Undo confirm-spam: reverse trainSpam + unhide
        if (post.spamTokens) {
          post.spamTokens.forEach(t => {
            if (state.spamFilter.spam[t]) state.spamFilter.spam[t]--;
          });
          state.spamFilter.spamCount = Math.max(0, state.spamFilter.spamCount - 1);
        }
        state.confirmedSpamUrns.delete(post.urn);
        state.hiddenUrns.delete(post.urn);
        state.hiddenPosts = state.hiddenPosts.filter(p => p.urn !== post.urn);
        post.isSpam = true;
      } else {
        // Undo not-spam: reverse trainHam + re-flag
        if (post.spamTokens) {
          post.spamTokens.forEach(t => {
            if (state.spamFilter.ham[t]) state.spamFilter.ham[t]--;
          });
          state.spamFilter.hamCount = Math.max(0, state.spamFilter.hamCount - 1);
        }
        post.isSpam = true;
      }
    } else {
      // Undo normal swipe
      if (action === 'remove') {
        state.hiddenUrns.delete(post.urn);
        state.hiddenPosts = state.hiddenPosts.filter(p => p.urn !== post.urn);
        // Reverse trainSpam
        if (post.spamTokens) {
          post.spamTokens.forEach(t => {
            if (state.spamFilter.spam[t]) state.spamFilter.spam[t]--;
          });
          state.spamFilter.spamCount = Math.max(0, state.spamFilter.spamCount - 1);
        }
      } else {
        state.likedUrns.delete(post.urn);
        state.likedPosts = state.likedPosts.filter(p => p.urn !== post.urn);
        // Reverse trainHam
        if (post.spamTokens) {
          post.spamTokens.forEach(t => {
            if (state.spamFilter.ham[t]) state.spamFilter.ham[t]--;
          });
          state.spamFilter.hamCount = Math.max(0, state.spamFilter.hamCount - 1);
        }
      }
    }

    // Go back one step
    state.tinderIndex = Math.max(0, state.tinderIndex - 1);

    // Save and update UI
    saveState();
    updateControlBar();
    if (state.sidebarOpen) updateSidebar();
    showCurrentTinderPost();

    log(`Undo: ${post.activityId} (${action}${last.spamReview ? ' spam-review' : ''})`);
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
          const urn = getPostUrn(node);
          if (urn && isSwipedPost(urn)) {
            node.remove();
            log(`Auto-removed swiped post: ${urn.slice(-12)}`);
            continue;
          }

          // Check children for swiped posts (old and new selectors)
          const posts = node.querySelectorAll?.('[data-urn], [data-td-urn], [data-view-tracking-scope]');
          if (posts) {
            posts.forEach(post => {
              const postUrn = getPostUrn(post);
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
    const elements = findPostElementsByUrn(urn);
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
      const elements = findPostElementsByUrn(urn);
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
    const urn = `urn:li:activity:${activityId}`;
    const matches = findPostElementsByUrn(urn);
    const postElement = matches[0] || null;
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
        'enabled', 'hiddenUrns', 'likedUrns', 'hiddenPosts', 'likedPosts',
        'spamFilter', 'confirmedSpamUrns'
      ]);
      if (data.enabled !== undefined) state.enabled = data.enabled;
      if (data.hiddenUrns) state.hiddenUrns = new Set(data.hiddenUrns);
      if (data.likedUrns) state.likedUrns = new Set(data.likedUrns);
      if (data.hiddenPosts) state.hiddenPosts = data.hiddenPosts;
      if (data.likedPosts) state.likedPosts = data.likedPosts;
      if (data.spamFilter) state.spamFilter = data.spamFilter;
      if (data.confirmedSpamUrns) state.confirmedSpamUrns = new Set(data.confirmedSpamUrns);
      log(`Loaded: ${state.hiddenUrns.size} hidden, ${state.likedUrns.size} liked, ${state.spamFilter.spamCount + state.spamFilter.hamCount} spam training docs, enabled=${state.enabled}`);
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
        spamFilter: state.spamFilter,
        confirmedSpamUrns: [...state.confirmedSpamUrns],
      });
      // Notify background for P2P sync propagation
      try { browser.runtime.sendMessage({ cmd: 'stateChanged' }); } catch (e) {}
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

    // QR pairing detection: check URL hash for #tinkedin-pair=SECRET
    const pairMatch = location.hash.match(/^#tinkedin-pair=([a-f0-9]{32})$/);
    if (pairMatch) {
      const secret = pairMatch[1];
      log('Sync: pairing detected from QR code');
      history.replaceState(null, '', location.pathname + location.search);
      try {
        await browser.storage.local.set({ syncSecret: secret, syncEnabled: true });
        browser.runtime.sendMessage({ cmd: 'syncStart', secret });
      } catch (e) {
        log('Sync: pairing error: ' + e.message);
      }
    }

    await loadState();
    seedSpamFilter();
    createControlBar();
    createSidebar();
    connectBackchannel();

    // Listen for messages from background script
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.cmd === 'syncStateUpdated') {
        // Peer synced new state — reload everything
        log('Sync: remote state received, reloading');
        loadState().then(() => {
          updateControlBar();
          if (state.sidebarOpen) updateSidebar();
          if (state.enabled) removeAllSwipedPostsFromDOM();
        });
        sendResponse({ ok: true });
        return true;
      }
      if (message.cmd === 'stateReset') {
        state.hiddenUrns.clear();
        state.likedUrns.clear();
        state.hiddenPosts = [];
        state.likedPosts = [];
        state.swipedPosts.clear();
        state.undoStack = [];
        state.enabled = true;
        state.spamFilter = { spam: {}, ham: {}, spamCount: 0, hamCount: 0 };
        state.confirmedSpamUrns.clear();
        state.spamReviewMode = false;
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
