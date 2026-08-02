import '../src/ui/index.js';
import { DEMO_WEBSOCKET_URL, installDemoWebSocket } from './demo-websocket.js';

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required demo element: ${selector}`);
  return element;
}

const mount = requiredElement<HTMLElement>('[data-demo-mount]');
const status = requiredElement<HTMLElement>('[data-demo-status]');

function updateStatus(message: string, state: 'loading' | 'ready' | 'error') {
  status.textContent = message;
  status.dataset.state = state;
  mount.dataset.demoState = state;
  mount.setAttribute('aria-busy', String(state === 'loading'));
}

document.addEventListener('securitypolicyviolation', (event) => {
  document.documentElement.dataset.cspViolation = event.violatedDirective;
  updateStatus(
    'The browser blocked a resource that violated the demo policy.',
    'error',
  );
});

async function startDemo(): Promise<void> {
  updateStatus('Starting the in-browser protocol simulator…', 'loading');

  // Install the zero-network transport before constructing the real UI.
  installDemoWebSocket();

  const terminal = document.createElement('lit-shell-terminal');
  terminal.url = DEMO_WEBSOCKET_URL;
  terminal.shell = '/bin/lit-shell-demo';
  terminal.cwd = '/demo';
  terminal.theme = 'dark';
  terminal.fontSize = 15;
  terminal.setAttribute(
    'aria-label',
    'Interactive simulated lit-shell terminal',
  );
  terminal.dataset.transport = 'in-memory-simulator';

  terminal.addEventListener('error', (event) => {
    event.preventDefault();
    updateStatus('The simulated terminal reported an error.', 'error');
  });

  mount.replaceChildren(terminal);

  await terminal.connect();
  await terminal.spawn({
    shell: '/bin/lit-shell-demo',
    cwd: '/demo',
    allowJoin: false,
    enableHistory: false,
  });

  const input = terminal.shadowRoot?.querySelector<HTMLTextAreaElement>(
    '.xterm-helper-textarea',
  );
  input?.setAttribute('aria-label', 'Simulated terminal input');

  document.documentElement.dataset.demoReady = 'true';
  updateStatus(
    'Ready. This terminal is simulated entirely in your browser.',
    'ready',
  );
}

void startDemo().catch((error: unknown) => {
  console.warn('[lit-shell demo] Startup failed:', error);
  updateStatus(
    'The browser demo could not start. No server connection was attempted.',
    'error',
  );
});
