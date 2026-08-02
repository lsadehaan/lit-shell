# lit-shell.js

> WebSocket-based terminal for Node.js - the truth is in your shell

[![CI](https://github.com/lsadehaan/lit-shell/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/lsadehaan/lit-shell/actions/workflows/ci.yml)
[![CodeQL](https://github.com/lsadehaan/lit-shell/actions/workflows/codeql.yml/badge.svg?branch=master)](https://github.com/lsadehaan/lit-shell/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/lit-shell.js)](https://www.npmjs.com/package/lit-shell.js)
[![license](https://img.shields.io/github/license/lsadehaan/lit-shell)](LICENSE)

A WebSocket terminal toolkit for web applications. It includes a Node.js
server backed by `node-pty`, a framework-agnostic client, and a ready-to-use
Lit web component.

> [!CAUTION]
> A terminal endpoint is remote code execution by design. lit-shell does not
> replace application authentication, authorization, TLS, origin validation,
> or process isolation. The default endpoint does not make an application
> identity or browser-origin decision. Sessions are private by default, but an
> authenticated sharing policy is still required before using `allowJoin: true`.
> Read [Security](#security)
> and [SECURITY.md](SECURITY.md) before exposing it beyond a trusted development
> environment.

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
- **Deployment Controls**: Configurable shell, path, container, session, and
  resource limits
- **Framework Agnostic**: Works with React, Vue, Angular, Svelte, or vanilla JS

## Installation

Node.js 22.13+ on the Node.js 22 line, or Node.js 24+, is required. Node.js 24
LTS is recommended for development and deployment.

For server use, install the optional native PTY peer alongside lit-shell:

```bash
npm install lit-shell.js node-pty
```

### Server-Side Requirements (node-pty)

`node-pty` may require native compilation. Install the platform tools required
by `node-gyp` if no prebuilt binary is available:

```bash
# Linux - install build essentials
sudo apt-get install build-essential python3

# macOS - install Xcode command line tools
xcode-select --install
```

See [node-pty docs](https://github.com/microsoft/node-pty) for platform-specific requirements.

### Client-Side (Browser)

For production, install the package and serve
`dist/ui/browser-bundle.js` from infrastructure you control. If a CDN is useful
for a prototype, pin the exact reviewed package version so a future release
cannot change executable terminal code without an application change:

```html
<!-- Exact version from unpkg -->
<script
  type="module"
  src="https://unpkg.com/lit-shell.js@1.2.1/dist/ui/browser-bundle.js"
></script>

<!-- Or the same exact version from jsDelivr -->
<script
  type="module"
  src="https://cdn.jsdelivr.net/npm/lit-shell.js@1.2.1/dist/ui/browser-bundle.js"
></script>
```

The bundle includes the `<lit-shell-terminal>` web component with xterm.js built-in.

## Quick Start

### Server Setup

```javascript
import { createServer } from 'node:http';
import { TerminalServer } from 'lit-shell.js/server';

const server = createServer();

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
<script
  type="module"
  src="https://unpkg.com/lit-shell.js@1.2.1/dist/ui/browser-bundle.js"
></script>

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
  url: 'ws://localhost:3000/terminal',
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
  cwd: '/home/user',
  allowJoin: false,
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

### Tab capabilities

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

### Tab use cases

#### Multi-environment development

```html
<!-- Open tabs for different containers -->
<lit-shell-terminal show-tabs show-connection-panel></lit-shell-terminal>
```

- Tab 1: Local shell for git operations
- Tab 2: Docker container for backend
- Tab 3: Docker container for frontend

#### Session sharing

- Create a session in Tab 1
- Create Tab 2, select "Join Existing Session"
- Both tabs now mirror the same terminal

#### Monitoring multiple processes

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

const terminalServer = new TerminalServer({
  allowedShells: ['/bin/bash', '/bin/zsh'],
  allowedPaths: ['/home/user', '/var/www'],
  defaultShell: '/bin/bash',
  defaultCwd: '/home/user',
  maxSessionsPerClient: 5,
  maxSessionsTotal: 100,
  maxClientsPerSession: 10,
  idleTimeout: 30 * 60 * 1000,
  cleanupInterval: 60_000,
  maxMessageBytes: 1024 * 1024,
  maxBufferedOutputBytes: 1024 * 1024,
  orphanTimeout: 60_000,
  historySize: 50_000,
  historyEnabled: true,
  path: '/terminal',
  verbose: false,
  allowLocalExec: true,
  allowDockerExec: false,
  allowedContainerPatterns: [],
  defaultContainerShell: '/bin/sh',
  allowedOrigins: ['https://terminal.example.com'],
  authorize: async (request) => authorizeUpgrade(request),
});

terminalServer.attach(httpServer);
terminalServer.getSessions();
terminalServer.getStats();
terminalServer.close();
```

`allowedPaths` validates only the initial working directory of a local
session. It is not a filesystem sandbox: after startup, the shell retains the
filesystem permissions of the server's operating-system account and can
change directories. Use an OS-level sandbox or appropriately constrained
container when filesystem isolation is required.

### Client

#### `TerminalClient`

```typescript
import { TerminalClient } from 'lit-shell.js/client';

const client = new TerminalClient({
  url: 'ws://localhost:3000/terminal',
  reconnect: true, // Auto-reconnect (default: true)
  maxReconnectAttempts: 10, // Max attempts (default: 10)
  reconnectDelay: 1000, // Initial delay ms (default: 1000)
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
  orphanTimeout: 3600000,
  label: 'my-session', // Optional label for identification
  allowJoin: true, // Explicitly make this session discoverable and joinable
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
client.isConnected(); // boolean
client.hasActiveSession(); // boolean
client.getSessionId(); // string | null
client.getSessionInfo(); // SessionInfo | null

// Session multiplexing
const sessions = await client.listSessions(); // Owned and explicitly shared sessions
const session = await client.join({
  // Join existing session
  sessionId: 'term-123...',
  requestHistory: true,
  historyLimit: 50000,
});
client.leave(sessionId); // Leave without killing

// Multiplexing event handlers
client.onClientJoined((sessionId, count) => console.log(`${count} clients`));
client.onClientLeft((sessionId, count) => console.log(`${count} clients`));
client.onSessionClosed((sessionId, reason) => console.log(reason));
// reason also includes 'idle_timeout', 'cleanup', and 'error'

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

| Attribute               | Type                              | Default                | Description                                         |
| ----------------------- | --------------------------------- | ---------------------- | --------------------------------------------------- |
| `url`                   | string                            | `''`                   | WebSocket URL                                       |
| `shell`                 | string                            | `''`                   | Shell to use                                        |
| `cwd`                   | string                            | `''`                   | Working directory                                   |
| `container`             | string                            | `''`                   | Docker container name                               |
| `container-shell`       | string                            | `''`                   | Shell inside container                              |
| `container-user`        | string                            | `''`                   | User in container                                   |
| `container-cwd`         | string                            | `''`                   | Working directory in container                      |
| `theme`                 | `'dark'` \| `'light'` \| `'auto'` | `'dark'`               | Color theme                                         |
| `font-size`             | number                            | `14`                   | Terminal font size                                  |
| `font-family`           | string                            | `'Cascadia Mono, ...'` | Terminal font                                       |
| `cols`                  | number                            | `80`                   | Initial columns                                     |
| `rows`                  | number                            | `24`                   | Initial rows                                        |
| `auto-connect`          | boolean                           | `false`                | Connect on mount                                    |
| `auto-spawn`            | boolean                           | `false`                | Spawn on connect                                    |
| `allow-join`            | boolean                           | `false`                | Make spawned sessions discoverable and joinable     |
| `no-header`             | boolean                           | `false`                | Hide header bar                                     |
| `show-connection-panel` | boolean                           | `false`                | Show connection panel with container/shell selector |
| `show-settings`         | boolean                           | `false`                | Show settings dropdown (theme, font size)           |
| `show-status-bar`       | boolean                           | `false`                | Show status bar with connection info and errors     |
| `show-tabs`             | boolean                           | `false`                | Enable tabbed terminal interface                    |

**Methods:**

```javascript
const terminal = document.querySelector('lit-shell-terminal');

await terminal.connect(); // Connect to server
terminal.disconnect(); // Disconnect
await terminal.spawn(); // Spawn session
terminal.kill(); // Kill session
terminal.clear(); // Clear display
terminal.write('text'); // Write to display
terminal.writeln('line'); // Write line to display
terminal.focus(); // Focus terminal

// Session multiplexing
await terminal.join(sessionId); // Join existing session
terminal.leave(); // Leave without killing

// Tab methods (when show-tabs is enabled)
terminal.createTab('label'); // Create new tab
terminal.switchTab('tab-id'); // Switch to tab
terminal.closeTab('tab-id'); // Close tab
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
  // Disable host shells when this process can reach the Docker daemon.
  allowLocalExec: false,
  allowDockerExec: true,

  // Restrict which containers can be accessed (regex patterns)
  allowedContainerPatterns: [
    '^myapp-.*$', // Containers starting with 'myapp-'
    '^dev-container$', // Exact match
    '^.*backend.*$', // Contains 'backend'
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
  container: 'my-container-name', // Container ID or name
  containerShell: '/bin/sh', // Shell inside container
  containerUser: 'root', // User to run as
  containerCwd: '/app', // Working directory in container
  env: { DEBUG: 'true' }, // Environment variables
  useTmux: true, // Optional persistent tmux session for Docker exec
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
  attachMode: true, // Use docker attach instead of docker exec
});
```

**Important:** Docker attach connects to whatever is running as PID 1. If the container was started with a non-interactive command (like a web server), attach may not provide useful interaction.

## Session Multiplexing

Session multiplexing allows multiple clients to connect to the same terminal session. This enables:

- **Collaboration**: Multiple users can share a terminal
- **Session Persistence**: Sessions survive client disconnects
- **History Replay**: New clients receive recent output when joining
- **Monitoring**: Watch others' terminal sessions in real-time

> [!WARNING]
> Sessions are private and hidden from other clients by default. Set
> `allowJoin: true` only for an intentional collaboration whose participants
> are authorized for that session. A session ID is not an authorization
> credential; owner reconnects use a separate, client-managed resume capability.

### How It Works

```text
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
  label: 'dev-session', // Optional label for identification
  allowJoin: true, // Explicitly enable discovery and sharing
  orphanTimeout: 3600000, // Keep alive 1 hour after last client leaves
});

// Join an existing session
const session = await client.join({
  sessionId: 'term-abc123...',
  requestHistory: true, // Request output history
  historyLimit: 50000, // Max history chars to receive
});
// session.history contains recent output

// Leave session without killing it
client.leave(sessionId);
// Session survives if other clients connected
// Or waits orphanTimeout before closing

// Kill session
client.kill();
```

### Multiplexing use cases

#### Pair programming

```javascript
// Developer A creates session
await client.spawn({ label: 'pair-session' });
// Share session ID with Developer B
// Developer B joins with history
await client.join({ sessionId, requestHistory: true });
```

#### Session persistence

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

#### Monitoring

```javascript
// An authorized observer joins the session.
await client.join({ sessionId, requestHistory: true });
// Joining is not read-only: joined clients can send terminal input.
```

## Mobile Support

On mobile devices, lit-shell automatically shows a touch keyboard with common terminal keys:

```text
Row 1: [ESC] [/] [-] [HOME] [↑] [END] [PGUP]
Row 2: [TAB] [CTRL] [ALT] [←] [↓] [→] [PGDN]
Row 3: [^C] [^D] [^Z] [^L] [^A] [^E] [^R] (expandable)
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

`TerminalServer` handles terminal protocol and lifecycle behavior. The host
application remains responsible for authenticating and authorizing the HTTP
upgrade before it reaches the terminal endpoint. Allowing a connection is
equivalent to allowing that principal to run the configured shell or container
process with the service account's privileges.

The network boundary remains intentionally unopinionated: the terminal endpoint
does not supply application authentication or a restrictive browser-origin
policy by itself. Spawned sessions are private by default, and session listings
show only a client's own sessions plus sessions explicitly shared with
`allowJoin: true`. `Origin` checking limits browser-based cross-site access; it
does not authenticate non-browser clients.

For any non-local deployment:

- terminate TLS and use `wss://`;
- enforce authentication, per-session authorization, and an explicit browser
  origin policy at the upgrade boundary;
- keep the private default (or send `allowJoin: false` explicitly) and enable
  sharing only for an authorized collaboration;
- prevent session discovery across tenants, or isolate tenants behind separate
  terminal server instances/endpoints when authorization cannot be enforced
  before protocol messages are handled;
- run as a dedicated least-privileged account or in a constrained sandbox;
- use exact shell, real working-directory, and container allowlists;
- set conservative client, session, idle, history, and process resource limits;
- avoid logging environment values, credentials, authorization headers, or
  terminal contents; and
- keep Node.js, lit-shell, `node-pty`, `ws`, containers, and the host patched.

Allowlists are defense in depth. They are not authentication or isolation.
Never expose the WebSocket endpoint directly to an untrusted network.

A minimal hardened configuration starts with narrow allowlists and limits:

```javascript
const server = new TerminalServer({
  // Restrict allowed shells
  allowedShells: ['/bin/bash'],

  // Restrict working directories
  allowedPaths: ['/home/app', '/var/www'],

  // Restrict Docker containers
  allowLocalExec: false,
  allowDockerExec: true,
  allowedContainerPatterns: ['^myapp-.*$'],

  // Limit sessions per client
  maxSessionsPerClient: 2,

  // Bound work retained before authorization and per protocol frame
  maxPreAuthMessages: 16,
  maxPreAuthBytes: 32 * 1024,
  maxMessageBytes: 256 * 1024,
  maxBufferedOutputBytes: 256 * 1024,

  // Set idle timeout
  idleTimeout: 10 * 60 * 1000,
});
```

Sessions are private by default; security-sensitive callers can also make that
intent explicit:

```javascript
await client.spawn({ shell: '/bin/bash', allowJoin: false });
```

See [SECURITY.md](SECURITY.md) for the deployment threat model and private
vulnerability-reporting process.

## Examples

See the [examples](./examples) directory for complete working examples:

- [**docker-container**](./examples/docker-container) - Connect to Docker containers from the browser
- [**multiplexing**](./examples/multiplexing) - Session multiplexing with multiple clients sharing terminals

### Running Locally (Development)

Development requires Node.js 22.13+ on the Node.js 22 line, or Node.js 24+;
Node.js 24 is the repository default. Use the committed npm lockfile:

```bash
# Clone the repository
git clone https://github.com/lsadehaan/lit-shell.git
cd lit-shell

# Install the exact graph, then build only the reviewed binary dependencies
npm ci
npm run deps:build

# Run the main quality gate and build the package
npm run validate
npm run build

# Start a test container (optional, for Docker exec testing)
docker run -d --name test-container alpine sleep infinity

# Run the example server
node examples/docker-container/server.js

# Open http://localhost:3000 in your browser
```

The browser suite needs the three Playwright engines once per machine:

```bash
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e:browser
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete command matrix,
black-box testing policy, CRAP ratchet, Python binding setup, and pull-request
expectations.

### Quick Start with Docker Compose

Run the full demo with Docker Compose (no local node-pty installation required):

```bash
cd docker
docker compose up -d
```

This starts:

- lit-shell server on <http://localhost:3000>
- Two test containers (Alpine and Ubuntu) to exec into

Open <http://localhost:3000> and use the connection panel to:

1. Select "Docker Container" mode
2. Choose a container from the dropdown
3. Click "Start Session"

Stop the demo:

```bash
docker compose down
```

## Project community

- [Contributing guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Support guide](SUPPORT.md)
- [Governance](GOVERNANCE.md)
- [Roadmap](roadmap.md)

Bug reports, focused improvements, documentation, tests, and protocol reviews
are welcome. Suspected vulnerabilities must use the private process in the
security policy, not a public issue.

## License

MIT
