# lit-shell.js

> WebSocket-based terminal for Node.js - the truth is in your shell

A plug-and-play terminal solution for web applications. Includes a server component (node-pty), client library, and ready-to-use Lit web component.

## Features

- **Server**: WebSocket server with node-pty for real shell sessions
- **Client**: Lightweight WebSocket client with auto-reconnection
- **UI**: `<lit-shell-terminal>` Lit web component with xterm.js
- **Docker Support**: Execute commands in Docker containers (exec or attach mode)
- **Session Multiplexing**: Multiple clients can share the same terminal session
- **Session Persistence**: Orphan timeout and tmux integration for long-running sessions
- **Mobile Support**: Touch keyboard with Termux-style layout for mobile devices
- **Multi-Tab**: Support for multiple terminal tabs in one component
- **Themes**: Built-in dark/light/auto theme support
- **Security**: Configurable shell, path, and container allowlists
- **Framework Agnostic**: Works with React, Vue, Angular, Svelte, or vanilla JS

## Installation

```bash
npm install lit-shell.js node-pty
```

Note: `node-pty` requires native compilation. See [node-pty docs](https://github.com/microsoft/node-pty) for platform-specific requirements.

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
<!-- Load lit-shell.js UI bundle (includes xterm.js) -->
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

## Docker Support

lit-shell supports executing commands inside Docker containers via two modes:

### Docker Exec Mode

Spawns a new shell inside a running container:

```javascript
const terminalServer = new TerminalServer({
  allowDockerExec: true,
  allowedContainerPatterns: ['my-app-.*', 'dev-container'],
  defaultContainerShell: '/bin/bash',
});

// Client-side
await client.spawn({
  container: 'my-container',
  containerShell: '/bin/bash',
  containerUser: 'node',
  containerCwd: '/app',
});
```

### Docker Attach Mode

Attaches to a container's main process (stdin/stdout):

```javascript
await client.spawn({
  container: 'my-container',
  attachMode: true,
});
```

## Session Multiplexing

Multiple clients can share the same terminal session:

```javascript
// First client spawns a session
const session = await client1.spawn({ shell: '/bin/bash' });

// Second client joins the same session
const shared = await client2.join({
  sessionId: session.sessionId,
  requestHistory: true,  // Replay terminal history
  historyLimit: 10000,
});

// Both clients now see the same terminal
// Either can type, both see the output
```

### Session List

```javascript
// Get available sessions
client.onSessionList((sessions) => {
  sessions.forEach(s => {
    console.log(`${s.sessionId}: ${s.shell} (${s.clientCount} clients)`);
  });
});

client.requestSessionList();
```

## Session Persistence

### Orphan Timeout

Sessions can persist after all clients disconnect:

```javascript
await client.spawn({
  shell: '/bin/bash',
  orphanTimeout: 3600000,  // Keep alive 1 hour after last client leaves
});
```

### Tmux Integration

For permanent session persistence:

```javascript
await client.spawn({
  shell: '/bin/bash',
  useTmux: true,  // Session persists indefinitely in tmux
});
```

## API Reference

### Server

#### `TerminalServer`

```typescript
import { TerminalServer } from 'lit-shell.js/server';

const server = new TerminalServer({
  // Shell configuration
  allowedShells: ['/bin/bash', '/bin/zsh'],
  defaultShell: '/bin/bash',

  // Path restrictions
  allowedPaths: ['/home/user', '/var/www'],
  defaultCwd: '/home/user',

  // Docker configuration
  allowDockerExec: false,
  allowedContainerPatterns: ['.*'],
  defaultContainerShell: '/bin/sh',

  // Session limits
  maxSessionsPerClient: 5,
  idleTimeout: 30 * 60 * 1000,

  // History
  historyEnabled: true,
  historySize: 50000,

  // WebSocket path
  path: '/terminal',

  // Logging
  verbose: false,
});

// Attach to HTTP server
server.attach(httpServer);

// Or start standalone
server.listen(3001);
```

### Client

#### `TerminalClient`

```typescript
import { TerminalClient } from 'lit-shell.js/client';

const client = new TerminalClient({
  url: 'ws://localhost:3000/terminal',
  reconnect: true,
  maxReconnectAttempts: 10,
  reconnectDelay: 1000,
});

// Connect
await client.connect();

// Spawn session
const session = await client.spawn({
  shell: '/bin/bash',
  cwd: '/home/user',
  env: { TERM: 'xterm-256color' },
  cols: 80,
  rows: 24,
  container: 'optional-container-name',
  orphanTimeout: 3600000,
  useTmux: false,
});

// Join existing session
const shared = await client.join({
  sessionId: 'session-id',
  requestHistory: true,
  historyLimit: 50000,
});

// Leave session (without killing it)
client.leave(sessionId);

// Terminal I/O
client.write('echo "Hello"\n');
client.resize(120, 40);
client.kill();

// Event handlers
client.onConnect(() => {});
client.onDisconnect(() => {});
client.onData((data) => {});
client.onExit((code) => {});
client.onError((err) => {});
client.onSpawned((info) => {});
client.onSessionList((sessions) => {});
client.onClientJoined((sessionId, count) => {});
client.onClientLeft((sessionId, count) => {});
client.onReconnectWithSession((sessionId) => {});
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
  cols="80"
  rows="24"
  auto-connect
  auto-spawn
  show-connection-panel
  show-status-bar
  show-tabs
  show-settings
></lit-shell-terminal>
```

**Attributes:**

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | `''` | WebSocket URL |
| `shell` | string | `''` | Shell to use |
| `cwd` | string | `''` | Working directory |
| `container` | string | `''` | Docker container name |
| `theme` | `'dark'` \| `'light'` \| `'auto'` | `'dark'` | Color theme |
| `font-size` | number | `14` | Terminal font size |
| `font-family` | string | `'Cascadia Mono, ...'` | Terminal font |
| `cols` | number | `80` | Initial columns |
| `rows` | number | `24` | Initial rows |
| `auto-connect` | boolean | `false` | Connect on mount |
| `auto-spawn` | boolean | `false` | Spawn on connect |
| `no-header` | boolean | `false` | Hide header bar |
| `show-connection-panel` | boolean | `false` | Show connection options |
| `show-status-bar` | boolean | `false` | Show status bar |
| `show-tabs` | boolean | `false` | Enable multi-tab mode |
| `show-settings` | boolean | `false` | Show settings menu |

**Methods:**

```javascript
const terminal = document.querySelector('lit-shell-terminal');

await terminal.connect();
terminal.disconnect();
await terminal.spawn(options);
await terminal.join(sessionId);
terminal.leave();
terminal.kill();
terminal.clear();
terminal.write('text');
terminal.writeln('line');
terminal.focus();

// Tab management (when show-tabs is enabled)
terminal.createTab('Label');
terminal.switchTab(tabId);
terminal.closeTab(tabId);
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

## Mobile Support

On mobile devices, lit-shell automatically shows a touch keyboard with common terminal keys:

```
Row 1: [ESC] [/] [-] [HOME] [↑] [END] [PGUP]
Row 2: [TAB] [CTRL] [ALT] [←] [↓] [→] [PGDN]
Row 3: [^C] [^D] [^Z] [^L] [^A] [^E] [^R]  (expandable)
```

- CTRL and ALT are sticky modifiers (tap to activate, applies to next key)
- Collapsible extra row for common control sequences
- Hide/show toggle for the entire keyboard

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

## License

MIT
