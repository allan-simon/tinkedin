# TinkeDin

A Firefox extension that adds a Tinder-style swipe interface to your LinkedIn feed. Swipe right to keep posts you're interested in, swipe left to hide the rest.

## Features

- **Tinder-style swipe overlay** - Browse your feed one post at a time with left/right swipe actions
- **Keyboard shortcuts** - Arrow keys to swipe, Ctrl+Z to undo, Escape to close
- **Floating control bar** - Discreet bottom-right widget with ON/OFF toggle, swipe mode, and stats
- **History sidebar** - Slide-in panel showing your liked and hidden posts, with undo
- **Promoted post auto-hiding** - Detects and removes sponsored posts automatically
- **Persistent state** - Your preferences survive page reloads and browser restarts
- **Auto "Show more" clicking** - Automatically loads more posts as you swipe through them

## Installation

1. Clone this repository
2. Open Firefox and go to `about:debugging`
3. Click "This Firefox" > "Load Temporary Add-on"
4. Select the `manifest.json` file from this repo

## Usage

1. Navigate to [linkedin.com/feed](https://www.linkedin.com/feed/)
2. The **TinkeDin** control bar appears in the bottom-right corner
3. Click **Swipe Mode** to open the Tinder-style overlay
4. Use **arrow keys** (or the buttons) to swipe left (hide) or right (keep)
5. Press **Ctrl+Z** to undo your last swipe
6. Press **Escape** to go back to the normal feed
7. Click **History** to review your liked and hidden posts

The ON/OFF toggle controls whether hidden posts are automatically removed from the feed as you scroll.

## Architecture

Everything runs in the content script on the LinkedIn tab. No API calls, no separate tabs, no background fetching.

```
LINKEDIN TAB (content.js)
├── Floating Control Bar (ON/OFF toggle, Swipe Mode, History, stats)
├── Hidden Post Observer (removes swiped posts from DOM)
├── Swipe Overlay (full-screen overlay, shows posts as cards)
├── History Sidebar (liked/hidden with undo)
└── Storage (browser.storage.local for persistence)

BACKGROUND.JS (minimal)
├── Storage queries for popup stats
└── State reset broadcast
```

Posts are collected directly from the DOM as the user scrolls. When entering swipe mode, each visible post is cloned immediately so DOM mutations don't affect the swipe experience.

## Development

### Debug tools

A WebSocket backchannel server is included for real-time debugging:

```bash
npm install
node backchannel-server.js
```

The extension will automatically connect when the server is running. You can then:

- Open `http://localhost:9777/state` for current state
- Open `http://localhost:9777/health` for connection status
- Use `node tinkedin-cli.js watch` to stream live updates

### Project structure

```
├── content.js            # All UI and logic (control bar, swipe overlay, sidebar)
├── background.js         # Minimal: storage queries + state reset
├── styles/tinkedin.css   # All styles
├── popup.html / popup.js # Browser action popup (stats + reset)
├── manifest.json         # Extension manifest (v2)
├── backchannel-server.js # Debug WebSocket server
├── tinkedin-cli.js       # CLI for the backchannel
└── query-dom.js          # DOM query utility
```

## License

MIT
