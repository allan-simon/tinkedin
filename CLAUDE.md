# TinkeDin - Development Notes

## Overview

TinkeDin is a Firefox extension that provides a Tinder-style swipe interface for the LinkedIn feed. Users can quickly swipe right to keep posts they're interested in, or swipe left to hide posts they don't want to see.

## Architecture (v2 - Per-Tab Overlay)

Everything runs directly in the content script on the LinkedIn tab. No separate tinder tab, no API fetching from background.js, no cross-tab messaging.

```
LINKEDIN TAB (content.js)
├── Floating Control Bar (ON/OFF toggle, Swipe Mode btn, History btn, stats)
├── Hidden Post Observer (when ON: removes swiped-left posts from DOM)
├── Swipe Overlay (full-screen overlay, shows DOM posts as cards)
├── History Sidebar (slide-in panel: liked/hidden with undo)
├── Backchannel WebSocket (debug logs)
└── Storage (browser.storage.local for persistence)

BACKGROUND.JS (minimal ~70 lines)
├── Backchannel WebSocket
└── Message handler (getStats, resetAll, reconnectBackchannel)
```

### Key Files
- `content.js` - All UI and logic: control bar, swipe overlay, history sidebar, hidden post removal
- `background.js` - Minimal: backchannel + storage queries for popup
- `styles/tinkedin.css` - All styles: control bar, sidebar, tinder overlay
- `popup.html` / `popup.js` - Simple stats display + reset button
- `backchannel-server.js` - Debug WebSocket server (unchanged)

### Previous Architecture (v1)
v1 used a three-layer approach: background.js fetched LinkedIn's GraphQL API, tinder-ui.js ran in a separate tab, and content.js manipulated the LinkedIn DOM. Messages between these layers were unreliable. v2 consolidated everything into the content script.

## Key Design Decisions

- **DOM-based post collection**: Posts come from the LinkedIn DOM as the user scrolls. No API calls. When entering swipe mode, we collect whatever posts are currently loaded.
- **Clone at scan time**: When entering swipe mode, each post element is cloned immediately. The clone is stored and displayed in the overlay, immune to DOM mutations.
- **Metadata extraction at swipe time**: When the user swipes, we extract author name, text preview, and image from the cloned DOM element for sidebar display.
- **ON/OFF persisted across sessions**: `state.enabled` saved to storage, restored on page load. Controls whether the MutationObserver removes hidden posts.
- **No background polling**: No alarms, no auto-fetch. Posts come from DOM scrolling.

## State Management

### Persisted State (browser.storage.local)
- `enabled` - ON/OFF toggle
- `hiddenUrns` - Set of URN strings for posts swiped left (for DOM matching)
- `likedUrns` - Set of URN strings for posts swiped right
- `hiddenPosts` - Array of post metadata for sidebar display (last 200)
- `likedPosts` - Array of post metadata for sidebar display (last 200)

### Post Metadata (for sidebar)
```javascript
{
  urn: 'urn:li:activity:12345',
  activityId: '12345',
  authorName: 'John Doe',
  textPreview: 'First 200 chars of post...',
  authorImage: 'https://...',
  url: 'https://www.linkedin.com/feed/update/urn:li:activity:12345/',
  swipedAt: 1234567890
}
```

### Session-Only State (in-memory)
- `swipedPosts` - URNs swiped this session (for tinder mode dedup)
- `tinderPosts` - Queue of cloned DOM elements for swipe overlay
- `tinderIndex` - Current position in swipe queue
- `undoStack` - Stack of {action, post, metadata} for Ctrl+Z

## Learnings

### Promoted Post Detection (DOM-based)
In v2, promoted posts are detected by scanning `<span>` elements for text like "Promoted", "Sponsoris\u00e9", "Gesponsert", "Patrocinado". Also checks for `[data-ad-banner]` and `.ad-banner` selectors.

### Post Element Selectors
LinkedIn posts in the DOM have `data-urn` attributes starting with `urn:li:activity:`. Key selectors for metadata extraction:
- Author name: `.update-components-actor__name span[aria-hidden="true"]`
- Post text: `.update-components-text`
- Author image: `.update-components-actor__image img`
- Show more button: `.scaffold-finite-scroll__load-button`

### Expanding Truncated Text
LinkedIn truncates long posts with CSS (`-webkit-line-clamp`, `max-height`). We expand them by:
1. Clicking "show more" on the ORIGINAL element before cloning
2. Removing collapsed classes on the clone
3. CSS overrides in `.tinder-post * { -webkit-line-clamp: unset !important; }`

## Features

- **Floating control bar** (bottom-right corner): ON/OFF toggle, Swipe Mode, History, stats
- **Tinder-style swipe overlay** with keyboard shortcuts (arrow keys) and Ctrl+Z undo
- **History sidebar** (slide-in from right): liked/hidden posts with undo buttons
- **Promoted post auto-hiding**: Detected and hidden automatically
- **Hidden post observer**: MutationObserver removes hidden posts as they appear in DOM
- **Auto "Show more" clicking**: Naturally clicks the "Show more feed updates" button
- **Persistent state** across sessions via browser.storage.local

## Feedback Loop

### WebSocket Backchannel
WebSocket server on port 9777 for real-time debugging. Both content.js and background.js connect.

```javascript
// Commands available via backchannel:
{ cmd: 'getState' }        // Get current extension state
{ cmd: 'toggleEnabled' }   // Toggle ON/OFF
{ cmd: 'setEnabled', value: true/false }
{ cmd: 'openSwipeMode' }   // Open tinder overlay
{ cmd: 'getDOM', selector: '...', depth: 2 }
{ cmd: 'getTinderState' }  // Get swipe mode state
{ cmd: 'querySelector', selector: '...', attrs: [...] }
{ cmd: 'exec', code: '...' }  // Execute JS (debugging only)
```

## Verification

1. Load extension in Firefox (`about:debugging` > Load Temporary Add-on > select `manifest.json`)
2. Navigate to linkedin.com/feed
3. Floating control bar should appear bottom-right
4. Toggle ON: hidden posts should disappear from feed
5. Click "Swipe Mode": overlay appears with current DOM posts
6. Swipe left/right with arrow keys: posts hide/keep, counter updates
7. Ctrl+Z: undo last swipe
8. Close overlay: swiped-left posts should be gone from feed
9. Click "History": sidebar slides in with liked/hidden posts
10. Click undo on a hidden post: removed from hidden set (reappears on next load)
11. Reload page: state persists, previously hidden posts still hidden
12. Run backchannel server (`node backchannel-server.js`), verify logs flow

## Future Improvements

- Extract images from posts for richer sidebar display
- Better reshare detection from DOM elements
- Sync liked posts to a reading list
- Export functionality via backchannel
