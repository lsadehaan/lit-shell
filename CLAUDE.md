# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

**lit-shell.js** is a WebSocket-based terminal solution for Node.js web applications. It provides a server component (node-pty), client library, and ready-to-use Lit web component.

## Development Commands

```bash
npm run build          # Compile TypeScript + browser bundles
npm run build:browser  # Build browser bundles only
npm run watch          # Watch mode for TypeScript
npm run clean          # Remove dist/ directory
npm test               # Run tests (placeholder for now)
```

## Architecture

### Three-Module System

The library exports three separate modules:

1. **`lit-shell.js/server`** - Server-side terminal handler
   - `TerminalServer` - WebSocket server with node-pty integration
   - `createTerminalMiddleware()` - Express middleware factory

2. **`lit-shell.js/client`** - Client-side terminal client
   - `TerminalClient` - WebSocket client with auto-reconnection

3. **`lit-shell.js/ui`** - Lit web components
   - `<lit-shell-terminal>` - Ready-to-use terminal component

### Source Structure

```
src/
├── server/
│   ├── index.ts           # Server exports
│   └── terminal-server.ts # WebSocket + node-pty handler
├── client/
│   ├── index.ts           # Client exports
│   └── terminal-client.ts # WebSocket client
├── shared/
│   └── types.ts           # Shared TypeScript types
└── ui/
    ├── index.ts           # UI exports
    ├── styles.ts          # Theme CSS custom properties
    └── lit-shell-terminal.ts # Lit web component
```

### Key Design Patterns

**WebSocket Protocol:**
- Messages are JSON with `type` field
- Types: `spawn`, `spawned`, `data`, `resize`, `close`, `error`, `exit`
- Session IDs track individual terminal sessions

**Dynamic Loading:**
- xterm.js is loaded dynamically from CDN in browser
- Fallback to npm package if CDN fails
- node-pty is a peer dependency (loaded at runtime)

**Theming:**
- CSS custom properties for all colors
- `theme` attribute: `dark`, `light`, `auto`
- Auto follows system preference via `prefers-color-scheme`

## Publishing

### Automated Release Process (CI/CD)

Publishing is automated via GitHub Actions:

1. **Update version in package.json**
2. **Commit and tag:**
   ```bash
   git add package.json
   git commit -m "chore: bump version to 0.x.x"
   git tag -a v0.x.x -m "Release v0.x.x"
   git push origin master --tags
   ```
3. **CI/CD automatically:**
   - Runs tests
   - Builds the project
   - Publishes to npm
   - Creates GitHub release

**Requirements:**
- `NPM_TOKEN` secret configured in GitHub repository

## Security Considerations

Terminal access is sensitive - always configure:

```javascript
const server = new TerminalServer({
  allowedShells: ['/bin/bash'],      // Restrict shells
  allowedPaths: ['/home/app'],       // Restrict directories
  maxSessionsPerClient: 2,           // Limit sessions
  idleTimeout: 10 * 60 * 1000,       // 10 min timeout
});
```

## Common Patterns

### Adding Server to Express App

```javascript
import express from 'express';
import { createServer } from 'http';
import { TerminalServer } from 'lit-shell.js/server';

const app = express();
const server = createServer(app);

const terminalServer = new TerminalServer({
  path: '/terminal',
  verbose: true,
});
terminalServer.attach(server);

server.listen(3000);
```

### Using the Web Component

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<script type="module" src="https://unpkg.com/lit-shell.js/dist/ui/browser-bundle.js"></script>

<lit-shell-terminal
  url="ws://localhost:3000/terminal"
  theme="dark"
  auto-connect
  auto-spawn
></lit-shell-terminal>
```

### Using the Client API Directly

```javascript
import { TerminalClient } from 'lit-shell.js/client';

const client = new TerminalClient({ url: 'ws://localhost:3000/terminal' });
await client.connect();
await client.spawn({ shell: '/bin/bash' });

client.onData((data) => console.log(data));
client.write('ls -la\n');
```
