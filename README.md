# lit-shell.js

> WebSocket-based terminal for Node.js - the truth is in your shell

A plug-and-play terminal solution for web applications. Includes a server component (node-pty), client library, and ready-to-use Lit web component.

## Features

- **Server**: WebSocket server with node-pty for real shell sessions
- **Client**: Lightweight WebSocket client with auto-reconnection
- **UI**: `<lit-shell-terminal>` Lit web component with xterm.js
- **Tabbed Terminals**: Multiple terminal tabs in a single component
- **Docker Exec**: Connect to Docker containers via `docker exec`
- **Docker Attach**: Connect to a container's main process (PID 1)
- **Session Multiplexing**: Multiple clients can share the same terminal session
- **Session Persistence**: Sessions survive client disconnects with configurable timeout
- **History Replay**: New clients receive recent terminal output when joining
- **Mobile Support**: Touch keyboard with Termux-style layout for mobile devices
- **Themes**: Built-in dark/light/auto theme support
- **Security**: Configurable shell, path, and container allowlists
- **Framework Agnostic**: Works with React, Vue, Angular, Svelte, or vanilla JS

## Installation

```bash
npm install lit-shell.js
```

### Server-Side Requirements (node-pty)

The server component requires `node-pty` for spawning terminal processes. Install it as a dev dependency:

```bash
npm install node-pty --save-dev
```

**Important:** `node-pty` requires native compilation. If you encounter installation issues:

```bash
# Linux - install build essentials
sudo apt-get install build-essential python3

# macOS - install Xcode command line tools
xcode-select --install

# If npm install fails, try:
npm install node-pty --save-dev --legacy-peer-deps

# Or rebuild native modules:
npm rebuild node-pty
```

See [node-pty docs](https://github.com/microsoft/node-pty) for platform-specific requirements.

### Client-Side (Browser)

The UI component can be loaded directly from a CDN - no build step required:

```html
<!-- Using unpkg -->
<script type="module" src="https://unpkg.com/lit-shell.js/dist/ui/browser-bundle.js"></script>

<!-- Or using jsDelivr -->
<script type="module" src="https://cdn.jsdelivr.net/npm/lit-shell.js/dist/ui/browser-bundle.js"></script>

<!-- Pin to a specific version -->
<script type="module" src="https://unpkg.com/lit-shell.js@1.2.0/dist/ui/browser-bundle.js"></script>
```

The bundle includes the `<lit-shell-terminal>` web component with xterm.js built-in.

## Quick Start

### Server Setup

```javascript
import express from 'express';
import { createServer } from 'http';
import { TerminalServer } from 'lit-shell.js/server';

const app = express();
const server = createServer(app);

// Create and attach terminal server
const terminalServer = new TerminalServer({
  allowedShells: ['/bin/bash', '/bin/zsh'],
  allowedPaths: ['/home/user'],
  defaultCwd: '/home/user',
  verbose: true,
});

terminalServer.attach(server);

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
```

### Client Usage (Web Component)

```html
<!-- Load lit-shell.js UI bundle -->
<script type="module" src="https://unpkg.com/lit-shell.js/dist/ui/browser-bundle.js"></script>

<!-- Use the component -->
<lit-shell-terminal
  url="ws://localhost:3000/terminal"
  theme="dark"
  auto-connect
  auto-spawn
></lit-shell-terminal>
```

### Client Usage (JavaScript)

```javascript
import { TerminalClient } from 'lit-shell.js/client';

const client = new TerminalClient({
  url: 'ws://localhost:3000/terminal'
});

await client.connect();

client.onData((data) => {
  console.log('Output:', data);
});

client.onExit((code) => {
  console.log('Exited with code:', code);
});

await client.spawn({
  shell: '/bin/bash',
  cwd: '/home/user'
});

client.write('ls -la\n');
client.resize(120, 40);
```

## Tabbed Terminals

Enable multiple terminal tabs within a single component using the `show-tabs` attribute:

```html
<lit-shell-terminal
  url="ws://localhost:3000/terminal"
  show-tabs
  show-connection-panel
  show-settings
  show-status-bar
></lit-shell-terminal>
```

### Features

- **Independent Sessions**: Each tab has its own WebSocket connection and terminal session
- **Tab Bar**: Shows all open tabs with status indicators
- **Dynamic Labels**: Tabs automatically update their label to show the shell or container name
- **Session Joining**: Create a tab and join an existing session from another tab
- **Easy Management**: Click "+" to add tabs, "×" to close, click tab to switch

### Tab API

```javascript
const terminal = document.querySelector('lit-shell-terminal');

// Create a new tab
const tab = terminal.createTab('My Terminal');
// Returns: { id: 'tab-1', label: 'My Terminal', ... }

// Switch to a specific tab
terminal.switchTab('tab-1');

// Close a tab (resources are cleaned up automatically)
terminal.closeTab('tab-1');

// Access tab state
// Each tab maintains its own: client, terminal, sessionInfo, etc.
```

### Use Cases

**1. Multi-Environment Development**
```html
<!-- Open tabs for different containers -->
<lit-shell-terminal show-tabs show-connection-panel></lit-shell-terminal>
```
- Tab 1: Local shell for git operations
- Tab 2: Docker container for backend
- Tab 3: Docker container for frontend

**2. Session Sharing**
- Create a session in Tab 1
- Create Tab 2, select "Join Existing Session"
- Both tabs now mirror the same terminal

**3. Monitoring Multiple Processes**
- Open multiple tabs
- Each tab connects to a different running session
- Monitor all processes from a single interface

## Built-in Connection Panel

When `show-connection-panel` is enabled, the terminal component provides a built-in UI for:

- **Mode Selection**: Switch between local shell, Docker exec, Docker attach, and join existing session modes
- **Container Picker**: Dropdown of running containers (when Docker is enabled on server)
- **Shell Selection**: Choose from server-allowed shells
- **Session Timeout**: Configure orphan timeout (1 min to 1 week)
- **Tmux Integration**: Option for permanent session persistence
- **Connect/Disconnect**: One-click session management

The connection panel automatically queries the server for:
- Docker availability and allowed containers
- Allowed shells and default configuration
- Available sessions for joining

```html
<!-- Full-featured terminal with all UI panels -->
<lit-shell-terminal
  url="ws://localhost:3000/terminal"
  show-connection-panel
  show-settings
  show-status-bar
></lit-shell-terminal>
```

## API Reference

### Server

#### `TerminalServer`

```typescript
import { TerminalServer } from 'lit-shell.js/server';

const server = new TerminalServer({
  // Allowed shells (empty = all allowed)
  allowedShells: ['/bin/bash', '/bin/zsh', 'cmd.exe'],

  // Allowed working directories (empty = all allowed)
  allowedPaths: ['/home/user', '/var/www'],

  // Default shell if not specified
  defaultShell: '/bin/bash',

  // Default working directory
  defaultCwd: '/home/user',

  // Max sessions per client (default: 5)
  maxSessionsPerClient: 5,

  // Idle timeout in ms (default: 30 minutes, 0 = disabled)
  idleTimeout: 30 * 60 * 1000,

  // WebSocket path (default: '/terminal')
  path: '/terminal',

  // Enable verbose logging
  verbose: false,

  // Session multiplexing options
  maxClientsPerSession: 10,     // Max clients per session (default: 10)
  orphanTimeout: 60000,         // Ms before orphaned sessions close (default: 60000)
  historySize: 50000,           // History buffer size in chars (default: 50000)
  historyEnabled: true,         // Enable history replay (default: true)
  maxSessionsTotal: 100,        // Max concurrent sessions (default: 100)

  // Docker configuration
  allowDockerExec: false,
  allowedContainerPatterns: ['.*'],
  defaultContainerShell: '/bin/sh',
});

// Attach to HTTP server
server.attach(httpServer);

// Or start standalone
server.listen(3001);

// Get active sessions
const sessions = server.getSessions();

// Get session statistics
const stats = server.getStats();
// { sessionCount: 5, clientCount: 12, orphanedCount: 1 }

// Close server
server.close();
```

### Client

#### `TerminalClient`

```typescript
import { TerminalClient } from 'lit-shell.js/client';

const client = new TerminalClient({
  url: 'ws://localhost:3000/terminal',
  reconnect: true,           // Auto-reconnect (default: true)
  maxReconnectAttempts: 10,  // Max attempts (default: 10)
  reconnectDelay: 1000,      // Initial delay ms (default: 1000)
});

// Connect to server
await client.connect();

// Spawn terminal session
const sessionInfo = await client.spawn({
  shell: '/bin/bash',
  cwd: '/home/user',
  env: { TERM: 'xterm-256color' },
  cols: 80,
  rows: 24,
  container: 'optional-container-name',
  orphanTimeout: 3600000,
  useTmux: false,
  label: 'my-session',      // Optional label for identification
  allowJoin: true,          // Allow others to join (default: true)
});

// Write to terminal
client.write('echo "Hello World"\n');

// Resize terminal
client.resize(120, 40);

// Kill session
client.kill();

// Disconnect
client.disconnect();

// Event handlers
client.onConnect(() => console.log('Connected'));
client.onDisconnect(() => console.log('Disconnected'));
client.onData((data) => console.log('Data:', data));
client.onExit((code) => console.log('Exit:', code));
client.onError((err) => console.log('Error:', err));
client.onSpawned((info) => console.log('Spawned:', info));

// State getters
client.isConnected();      // boolean
client.hasActiveSession(); // boolean
client.getSessionId();     // string | null
client.getSessionInfo();   // SessionInfo | null

// Session multiplexing
const sessions = await client.listSessions();  // List all sessions
const session = await client.join({            // Join existing session
  sessionId: 'term-123...',
  requestHistory: true,
  historyLimit: 50000,
});
client.leave(sessionId);                       // Leave without killing

// Multiplexing event handlers
client.onClientJoined((sessionId, count) => console.log(`${count} clients`));
client.onClientLeft((sessionId, count) => console.log(`${count} clients`));
client.onSessionClosed((sessionId, reason) => console.log(reason));
// reason: 'orphan_timeout' | 'owner_closed' | 'process_exit' | 'error'

// Reconnection with session recovery
client.onReconnectWithSession((sessionId) => {
  // Previous session is still available after reconnect
});
```

### UI Component

#### `<lit-shell-terminal>`

```html
<lit-shell-terminal
  url="ws://localhost:3000/terminal"
  shell="/bin/bash"
  cwd="/home/user"
  theme="dark"
  font-size="14"
  font-family="Cascadia Mono, Consolas, monospace"
  cols="80"
  rows="24"
  auto-connect
  auto-spawn
  no-header
  show-connection-panel
  show-settings
  show-status-bar
  show-tabs
></lit-shell-terminal>
```

**Attributes:**

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | `''` | WebSocket URL |
| `shell` | string | `''` | Shell to use |
| `cwd` | string | `''` | Working directory |
| `container` | string | `''` | Docker container name |
| `container-shell` | string | `''` | Shell inside container |
| `container-user` | string | `''` | User in container |
| `container-cwd` | string | `''` | Working directory in container |
| `theme` | `'dark'` \| `'light'` \| `'auto'` | `'dark'` | Color theme |
| `font-size` | number | `14` | Terminal font size |
| `font-family` | string | `'Cascadia Mono, ...'` | Terminal font |
| `cols` | number | `80` | Initial columns |
| `rows` | number | `24` | Initial rows |
| `auto-connect` | boolean | `false` | Connect on mount |
| `auto-spawn` | boolean | `false` | Spawn on connect |
| `no-header` | boolean | `false` | Hide header bar |
| `show-connection-panel` | boolean | `false` | Show connection panel with container/shell selector |
| `show-settings` | boolean | `false` | Show settings dropdown (theme, font size) |
| `show-status-bar` | boolean | `false` | Show status bar with connection info and errors |
| `show-tabs` | boolean | `false` | Enable tabbed terminal interface |

**Methods:**

```javascript
const terminal = document.querySelector('lit-shell-terminal');

await terminal.connect();     // Connect to server
terminal.disconnect();        // Disconnect
await terminal.spawn();       // Spawn session
terminal.kill();              // Kill session
terminal.clear();             // Clear display
terminal.write('text');       // Write to display
terminal.writeln('line');     // Write line to display
terminal.focus();             // Focus terminal

// Session multiplexing
await terminal.join(sessionId);  // Join existing session
terminal.leave();                // Leave without killing

// Tab methods (when show-tabs is enabled)
terminal.createTab('label');  // Create new tab
terminal.switchTab('tab-id'); // Switch to tab
terminal.closeTab('tab-id');  // Close tab
```

**Events:**

```javascript
terminal.addEventListener('connect', () => {});
terminal.addEventListener('disconnect', () => {});
terminal.addEventListener('spawned', (e) => console.log(e.detail.session));
terminal.addEventListener('exit', (e) => console.log(e.detail.exitCode));
terminal.addEventListener('error', (e) => console.log(e.detail.error));
terminal.addEventListener('theme-change', (e) => console.log(e.detail.theme));
```

## Docker Container Support

lit-shell.js can connect to Docker containers, allowing you to exec into running containers directly from the browser.

### Server Configuration

```javascript
const server = new TerminalServer({
  // Enable Docker exec feature
  allowDockerExec: true,

  // Restrict which containers can be accessed (regex patterns)
  allowedContainerPatterns: [
    '^myapp-',           // Containers starting with 'myapp-'
    '^dev-container$',   // Exact match
    'backend',           // Contains 'backend'
  ],

  // Default shell for containers
  defaultContainerShell: '/bin/bash',

  // Path to Docker CLI (default: 'docker')
  dockerPath: '/usr/bin/docker',

  verbose: true,
});
```

### Client Usage

```javascript
// Connect to a Docker container
await client.spawn({
  container: 'my-container-name',  // Container ID or name
  containerShell: '/bin/sh',       // Shell inside container
  containerUser: 'root',           // User to run as
  containerCwd: '/app',            // Working directory in container
  env: { DEBUG: 'true' },          // Environment variables
});
```

### Web Component

```html
<lit-shell-terminal
  url="ws://localhost:3000/terminal"
  container="my-container-name"
  container-shell="/bin/bash"
  container-user="node"
  container-cwd="/app"
  theme="dark"
  auto-connect
  auto-spawn
></lit-shell-terminal>
```

### Docker Attach Mode

Docker attach connects to a container's main process (PID 1) instead of spawning a new shell. This is useful for:
- Interacting with interactive containers started with `docker run -it`
- Debugging container startup issues
- Sharing a session with `docker attach` from another terminal

```javascript
// Client: Attach to container's main process
await client.spawn({
  container: 'my-container',
  attachMode: true,  // Use docker attach instead of docker exec
});
```

**Important:** Docker attach connects to whatever is running as PID 1. If the container was started with a non-interactive command (like a web server), attach may not provide useful interaction.

## Session Multiplexing

Session multiplexing allows multiple clients to connect to the same terminal session. This enables:
- **Collaboration**: Multiple users can share a terminal
- **Session Persistence**: Sessions survive client disconnects
- **History Replay**: New clients receive recent output when joining
- **Monitoring**: Watch others' terminal sessions in real-time

### How It Works

```
┌──────────┐     ┌─────────────────────────────────────────┐     ┌──────────┐
│ Client A │◄────┤           SessionManager                 ├────►│   PTY    │
└──────────┘     │  ┌─────────────────────────────────────┐ │     │ Process  │
                 │  │         SharedSession                │ │     └──────────┘
┌──────────┐     │  │  - clients: [A, B, C]               │ │
│ Client B │◄────┼──┤  - historyBuffer (50KB)             │ │
└──────────┘     │  │  - orphanedAt: null                 │ │
                 │  └─────────────────────────────────────┘ │
┌──────────┐     │                                         │
│ Client C │◄────┼─────────────────────────────────────────┘
└──────────┘              (broadcast output)
```

### Client API

```javascript
// List available sessions
const sessions = await client.listSessions();

// Create a shareable session
await client.spawn({
  shell: '/bin/bash',
  label: 'dev-session',      // Optional label for identification
  allowJoin: true,           // Allow others to join (default: true)
  orphanTimeout: 3600000,    // Keep alive 1 hour after last client leaves
});

// Join an existing session
const session = await client.join({
  sessionId: 'term-abc123...',
  requestHistory: true,      // Request output history
  historyLimit: 50000,       // Max history chars to receive
});
// session.history contains recent output

// Leave session without killing it
client.leave(sessionId);
// Session survives if other clients connected
// Or waits orphanTimeout before closing

// Kill session
client.kill();
```

### Use Cases

**1. Pair Programming**
```javascript
// Developer A creates session
await client.spawn({ label: 'pair-session' });
// Share session ID with Developer B
// Developer B joins with history
await client.join({ sessionId, requestHistory: true });
```

**2. Session Persistence**
```javascript
// Start long-running task
await client.spawn({ shell: '/bin/bash', orphanTimeout: 86400000 });
client.write('npm run build\n');
client.disconnect(); // Session survives!

// Later, reconnect
await client.connect();
const sessions = await client.listSessions();
await client.join({ sessionId: sessions[0].sessionId, requestHistory: true });
// See build output that happened while disconnected
```

**3. Monitoring**
```javascript
// Admin joins session in read-only mode
await client.join({ sessionId, requestHistory: true });
// Watch activity without interfering
```

## Mobile Support

On mobile devices, lit-shell automatically shows a touch keyboard with common terminal keys:

```
Row 1: [ESC] [/] [-] [HOME] [↑] [END] [PGUP]
Row 2: [TAB] [CTRL] [ALT] [←] [↓] [→] [PGDN]
Row 3: [^C] [^D] [^Z] [^L] [^A] [^E] [^R]  (expandable)
```

- **Auto-detection**: Detects mobile via touch capability + viewport size
- **Sticky modifiers**: CTRL and ALT are toggle keys (tap to activate, applies to next key)
- **Collapsible**: Extra row can be expanded/collapsed for more screen space
- **Hide/show toggle**: Entire keyboard can be hidden when not needed

## Theming

The component uses CSS custom properties for theming:

```css
lit-shell-terminal {
  --ls-bg: #1e1e1e;
  --ls-bg-header: #2d2d2d;
  --ls-text: #cccccc;
  --ls-text-muted: #808080;
  --ls-border: #3e3e3e;
  --ls-terminal-bg: #1e1e1e;
  --ls-terminal-fg: #cccccc;
  --ls-terminal-cursor: #ffffff;
  --ls-terminal-selection: #264f78;
  --ls-btn-bg: #3c3c3c;
  --ls-btn-text: #cccccc;
  --ls-btn-hover: #4a4a4a;
  --ls-status-connected: #22c55e;
  --ls-status-disconnected: #ef4444;
}
```

## Security

**Always configure security for production:**

```javascript
const server = new TerminalServer({
  // Restrict allowed shells
  allowedShells: ['/bin/bash'],

  // Restrict working directories
  allowedPaths: ['/home/app', '/var/www'],

  // Restrict Docker containers
  allowDockerExec: true,
  allowedContainerPatterns: ['^myapp-'],

  // Limit sessions per client
  maxSessionsPerClient: 2,

  // Set idle timeout
  idleTimeout: 10 * 60 * 1000,
});
```

## Examples

See the [examples](./examples) directory for complete working examples:

- [**docker-container**](./examples/docker-container) - Connect to Docker containers from the browser
- [**multiplexing**](./examples/multiplexing) - Session multiplexing with multiple clients sharing terminals

### Running Locally (Development)

```bash
# Clone the repository
git clone https://github.com/lsadehaan/lit-shell.git
cd lit-shell

# Install dependencies (including node-pty)
npm install
npm install node-pty --save-dev --legacy-peer-deps

# Build the project
npm run build

# Start a test container (optional, for Docker exec testing)
docker run -d --name test-container alpine sleep infinity

# Run the example server
node examples/docker-container/server.js

# Open http://localhost:3000 in your browser
```

### Quick Start with Docker Compose

Run the full demo with Docker Compose (no local node-pty installation required):

```bash
cd docker
docker compose up -d
```

This starts:
- lit-shell server on http://localhost:3000
- Two test containers (Alpine and Ubuntu) to exec into

Open http://localhost:3000 and use the connection panel to:
1. Select "Docker Container" mode
2. Choose a container from the dropdown
3. Click "Start Session"

Stop the demo:

```bash
docker compose down
```

## License

MIT
