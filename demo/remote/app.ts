import { LitShellTerminal } from '../../src/ui/index.js';

declare const __LIT_SHELL_REMOTE_BUILD_MARKER__: string;

document.documentElement.dataset.remoteBuild =
  __LIT_SHELL_REMOTE_BUILD_MARKER__;

const applicationProtocol = 'lit-shell.v1';
const admissionProtocolPrefix = 'lit-shell.admission.';
const wakeDeadlineMs = 90_000;

interface AdmissionResponse {
  readonly expiresAt: string;
  readonly protocol: string;
  readonly sessionLifetimeMs: number;
  readonly token: string;
  readonly webSocketPath: string;
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element)
    throw new Error(`Missing required remote-demo element: ${selector}`);
  return element;
}

const originMeta = requiredElement<HTMLMetaElement>(
  'meta[name="lit-shell-remote-origin"]',
);
const mount = requiredElement<HTMLElement>('[data-remote-mount]');
const status = requiredElement<HTMLElement>('[data-remote-status]');
const countdown = requiredElement<HTMLElement>('[data-remote-countdown]');
const startButton = requiredElement<HTMLButtonElement>('[data-remote-start]');
const endButton = requiredElement<HTMLButtonElement>('[data-remote-end]');
const remoteOrigin = originMeta.content;
const idleMountNodes = Array.from(mount.childNodes, (node) =>
  node.cloneNode(true),
);

let activeTerminal: LitShellTerminal | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let starting = false;

function updateStatus(
  message: string,
  state: 'idle' | 'loading' | 'ready' | 'error',
): void {
  status.textContent = message;
  status.dataset.state = state;
  status.setAttribute('role', state === 'error' ? 'alert' : 'status');
  status.setAttribute('aria-live', state === 'error' ? 'assertive' : 'polite');
  mount.dataset.demoState = state;
  mount.setAttribute('aria-busy', String(state === 'loading'));
}

function configuredOrigin(): URL {
  const parsed = new URL(remoteOrigin);
  if (parsed.protocol !== 'https:' || parsed.origin !== remoteOrigin) {
    throw new Error('The remote demo origin is not a normalized HTTPS origin');
  }
  return parsed;
}

function webSocketUrl(origin: URL): string {
  const url = new URL('/terminal', origin);
  url.protocol = 'wss:';
  return url.href;
}

async function wakeService(origin: URL): Promise<void> {
  const deadline = Date.now() + wakeDeadlineMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/health/ready', origin), {
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(30_000),
      });
      if (new URL(response.url).origin !== origin.origin) {
        throw new Error('The readiness response changed origin');
      }
      if (response.ok) return;
      lastError = new Error(`Readiness returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error('The free demo did not wake within 90 seconds', {
    cause: lastError,
  });
}

async function requestAdmission(origin: URL): Promise<AdmissionResponse> {
  const response = await fetch(new URL('/v1/admissions', origin), {
    cache: 'no-store',
    credentials: 'omit',
    method: 'POST',
    mode: 'cors',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
  if (response.status === 429) {
    const retry = response.headers.get('retry-after');
    throw new Error(
      `The single demo slot is busy. Try again${retry ? ` in about ${retry} seconds` : ' shortly'}.`,
    );
  }
  if (!response.ok) {
    throw new Error(`Admission failed with HTTP ${response.status}`);
  }
  return validateAdmission(await response.json());
}

function validateAdmission(value: unknown): AdmissionResponse {
  if (!isRecord(value)) throw new Error('Admission returned invalid JSON');
  const { expiresAt, protocol, sessionLifetimeMs, token, webSocketPath } =
    value;
  if (
    typeof expiresAt !== 'string' ||
    Number.isNaN(Date.parse(expiresAt)) ||
    protocol !== applicationProtocol ||
    !Number.isSafeInteger(sessionLifetimeMs) ||
    (sessionLifetimeMs as number) < 1 ||
    (sessionLifetimeMs as number) > 65_000 ||
    typeof token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
    webSocketPath !== '/terminal'
  ) {
    throw new Error('Admission response failed validation');
  }
  return value as unknown as AdmissionResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function startCountdown(lifetimeMs: number): void {
  if (countdownTimer) clearInterval(countdownTimer);
  const deadline = Date.now() + lifetimeMs;
  countdown.hidden = false;
  const render = () => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    countdown.textContent = `${remaining}s remaining`;
  };
  render();
  countdownTimer = setInterval(render, 250);
}

function stopCountdown(): void {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = undefined;
  countdown.hidden = true;
  countdown.textContent = '';
}

function releaseTerminal(terminal: LitShellTerminal): void {
  if (activeTerminal === terminal) activeTerminal = undefined;
  terminal.clearProtocols();
  terminal.disconnect();
  if (terminal.parentNode === mount) restoreIdleMount();
}

function restoreIdleMount(): void {
  mount.replaceChildren(...idleMountNodes.map((node) => node.cloneNode(true)));
}

function focusStartButton(): void {
  startButton.focus({ preventScroll: true });
}

function sessionEnded(
  terminal: LitShellTerminal,
  message = 'Session ended. You may request a new one.',
): void {
  if (activeTerminal !== terminal) return;
  releaseTerminal(terminal);
  stopCountdown();
  startButton.disabled = false;
  endButton.hidden = true;
  updateStatus(message, 'idle');
  focusStartButton();
}

function sessionFailed(terminal: LitShellTerminal, message: string): void {
  if (activeTerminal !== terminal) return;
  releaseTerminal(terminal);
  stopCountdown();
  startButton.disabled = false;
  endButton.hidden = true;
  updateStatus(message, 'error');
  focusStartButton();
}

async function startRemoteDemo(): Promise<void> {
  if (starting || activeTerminal) return;
  starting = true;
  startButton.disabled = true;
  updateStatus(
    'Waking the free service. This can take about a minute…',
    'loading',
  );
  try {
    const origin = configuredOrigin();
    await wakeService(origin);
    updateStatus('Requesting the single anonymous demo slot…', 'loading');
    const admission = await requestAdmission(origin);
    if (Date.parse(admission.expiresAt) <= Date.now()) {
      throw new Error('The admission capability expired before use');
    }

    const terminal = new LitShellTerminal();
    terminal.url = webSocketUrl(origin);
    terminal.protocols = [
      admission.protocol,
      `${admissionProtocolPrefix}${admission.token}`,
    ];
    terminal.reconnect = false;
    terminal.theme = 'dark';
    terminal.fontSize = 15;
    terminal.noHeader = true;
    terminal.screenReaderMode = true;
    terminal.setAttribute('aria-label', 'Isolated remote shell terminal');
    terminal.addEventListener('disconnect', () => {
      sessionEnded(terminal);
    });
    terminal.addEventListener('exit', () => {
      sessionEnded(
        terminal,
        'The shell process exited. You may request a new one.',
      );
    });
    terminal.addEventListener('session-closed', () => {
      sessionEnded(terminal);
    });
    terminal.addEventListener('error', (event: Event) => {
      const detail =
        'detail' in event && isRecord(event.detail) ? event.detail : undefined;
      const message =
        detail?.error instanceof Error
          ? detail.error.message
          : 'The remote terminal reported a protocol error.';
      sessionFailed(terminal, message);
    });

    activeTerminal = terminal;
    mount.replaceChildren(terminal);
    await terminal.connect();
    terminal.clearProtocols();
    await terminal.spawn({ allowJoin: false, cols: 80, rows: 24 });
    terminal.shadowRoot
      ?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      ?.setAttribute('aria-label', 'Remote shell terminal input');
    endButton.hidden = false;
    startCountdown(admission.sessionLifetimeMs);
    updateStatus('Connected to the isolated remote PTY.', 'ready');
  } catch (error) {
    if (activeTerminal) releaseTerminal(activeTerminal);
    else restoreIdleMount();
    startButton.disabled = false;
    endButton.hidden = true;
    stopCountdown();
    updateStatus(
      error instanceof Error
        ? error.message
        : 'The remote demo could not start.',
      'error',
    );
    focusStartButton();
  } finally {
    starting = false;
  }
}

startButton.addEventListener('click', () => void startRemoteDemo());
endButton.addEventListener('click', () => {
  const terminal = activeTerminal;
  if (!terminal) return;
  endButton.disabled = true;
  sessionEnded(terminal, 'Session ended by you. You may request a new one.');
  endButton.disabled = false;
});

document.addEventListener('securitypolicyviolation', (event) => {
  document.documentElement.dataset.cspViolation = event.violatedDirective;
  const message =
    'The browser blocked a resource that violated the demo policy.';
  if (activeTerminal) sessionFailed(activeTerminal, message);
  else updateStatus(message, 'error');
});

if (window.top !== window.self) {
  startButton.disabled = true;
  updateStatus(
    'The real shell demo cannot run inside an embedded frame.',
    'error',
  );
} else if (!remoteOrigin) {
  startButton.disabled = true;
  updateStatus(
    'The hardened remote service is not connected yet. The safe simulator remains available.',
    'idle',
  );
}
