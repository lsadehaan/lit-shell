# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2025-02-01

### Changed

- Comprehensive README update with full documentation
- Added Tabbed Terminals section with Tab API and use cases
- Added Built-in Connection Panel section
- Added Session Multiplexing diagram
- Added Docker Compose quick start instructions
- Added Examples section with local development guide
- Added Client-Side CDN loading instructions

## [1.2.0] - 2025-02-01

### Added

- **Mobile Support**: Auto-detect mobile devices and show touch keyboard
  - Termux-style layout: ESC, arrows, HOME/END, PGUP/PGDN, TAB
  - Sticky CTRL and ALT modifiers
  - Collapsible extra row with common control sequences (^C, ^D, ^Z, ^L, ^A, ^E, ^R)
  - Hide/show toggle for entire keyboard
  - Responsive viewport detection with media query listener
- **Reconnect Dialog**: After WebSocket reconnection, shows dialog to rejoin previous session
  - Saves session ID on disconnect
  - Checks if session still exists after reconnect
  - Option to rejoin with history or start fresh
- **Session Persistence Options**: Connection panel now includes
  - Configurable orphan timeout (1 min to 1 week)
  - Tmux integration checkbox for permanent persistence
- **Updated Font Stack**: Terminal now uses Cascadia Mono as primary font for better cross-platform consistency

### Changed

- Improved README documentation with all new features
- Updated feature list to include Docker, multiplexing, mobile, and persistence

## [1.1.0] - 2025-01-09

### Added

- **Tabbed Terminals**: New `show-tabs` attribute enables multiple terminal tabs in a single component
  - Each tab has independent WebSocket connection and terminal session
  - Tab bar with status indicators and add/close buttons
  - Dynamic labels showing shell or container name
  - `createTab()`, `switchTab()`, `closeTab()` methods
- **Join Existing Session**: Connection panel now shows "Join Existing Session" mode when sessions are available
- **Prompt Refresh on Join**: Joining a session now triggers a fresh prompt display

### Fixed

- Fixed duplicate output when multiple tabs join the same session
- Fixed session list not updating after spawning a session
- Each client's data handler now correctly writes to its own tab's terminal

## [1.0.0] - 2025-01-08

### Added

- Initial release
- WebSocket-based terminal server with node-pty
- Lightweight client library with auto-reconnection
- `<lit-shell-terminal>` Lit web component with xterm.js
- Docker exec support for connecting to containers
- Docker attach mode for connecting to container's main process (PID 1)
- Session multiplexing - multiple clients sharing the same terminal
- Session persistence with configurable orphan timeout
- History replay for clients joining existing sessions
- Built-in connection panel with container/shell selector
- Settings dropdown (theme, font size)
- Status bar with connection info
- Dark/light/auto theme support
- Security features: shell, path, and container allowlists
- Python client bindings (`bindings/python/`)
- Example projects for Docker containers and multiplexing
