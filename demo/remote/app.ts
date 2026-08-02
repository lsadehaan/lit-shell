import { LitShellTerminal } from '../../src/ui/index.js';

declare const __LIT_SHELL_REMOTE_BUILD_MARKER__: string;

document.documentElement.dataset.remoteBuild =
  __LIT_SHELL_REMOTE_BUILD_MARKER__;

const applicationProtocol = 'lit-shell.v1';
const admissionProtocolPrefix = 'lit-shell.admission.';
const turnstileScriptUrl =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const turnstileAction = 'remote_shell_admission';
const turnstileLoadTimeoutMs = 20_000;
const admissionRequestTimeoutMs = 10_000;
const wakeDeadlineMs = 90_000;

interface AdmissionResponse {
  readonly expiresAt: string;
  readonly protocol: string;
  readonly resetAt: string;
  readonly sessionLifetimeMs: number;
  readonly token: string;
  readonly webSocketPath: string;
}

interface TimedAdmissionResponse extends AdmissionResponse {
  readonly receivedAtMonotonicMs: number;
}

interface TurnstileScriptState {
  readonly element: HTMLScriptElement;
  readonly loaded: Promise<TurnstileApi>;
}

interface TurnstileApi {
  remove(widgetId: string): void;
  render(
    container: HTMLElement,
    options: {
      readonly action: string;
      readonly appearance: 'always';
      readonly callback: (token: string) => void;
      readonly 'error-callback': () => boolean;
      readonly 'expired-callback': () => void;
      readonly 'response-field': false;
      readonly sitekey: string;
      readonly size: 'flexible';
      readonly theme: 'auto';
      readonly 'timeout-callback': () => void;
      readonly 'unsupported-callback': () => void;
    },
  ): string;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
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
const siteKeyMeta = requiredElement<HTMLMetaElement>(
  'meta[name="lit-shell-turnstile-site-key"]',
);
const mount = requiredElement<HTMLElement>('[data-remote-mount]');
const status = requiredElement<HTMLElement>('[data-remote-status]');
const countdown = requiredElement<HTMLElement>('[data-remote-countdown]');
const startButton = requiredElement<HTMLButtonElement>('[data-remote-start]');
const endButton = requiredElement<HTMLButtonElement>('[data-remote-end]');
const turnstilePanel = requiredElement<HTMLElement>('[data-turnstile-panel]');
const turnstileMount = requiredElement<HTMLElement>('[data-turnstile-mount]');
const remoteOrigin = originMeta.content;
const turnstileSiteKey = siteKeyMeta.content;
const idleMountNodes = Array.from(mount.childNodes, (node) =>
  node.cloneNode(true),
);

let activeTerminal: LitShellTerminal | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let starting = false;
let turnstileScriptState: TurnstileScriptState | undefined;
let widgetId: string | undefined;

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
  const deadline = performance.now() + wakeDeadlineMs;
  let lastError: unknown;
  while (performance.now() < deadline) {
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

async function requestAdmission(
  origin: URL,
  turnstileToken: string,
): Promise<TimedAdmissionResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    admissionRequestTimeoutMs,
  );
  let response: Response;
  try {
    response = await fetch(new URL('/v1/admissions', origin), {
      body: new URLSearchParams({ turnstileToken }),
      cache: 'no-store',
      credentials: 'omit',
      method: 'POST',
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('The admission request timed out. Please try again.', {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 403) {
    throw new Error('Human verification was not accepted. Please try again.');
  }
  if (response.status === 429) {
    const retry = response.headers.get('retry-after');
    throw new Error(
      `The tiny shared demo is busy. Try again${retry ? ` in about ${retry} seconds` : ' shortly'}.`,
    );
  }
  if (response.status === 503) {
    throw new Error(
      'The shared environment is resetting or verification is temporarily unavailable. Please try again.',
    );
  }
  if (!response.ok) {
    throw new Error(`Admission failed with HTTP ${response.status}`);
  }
  return {
    ...validateAdmission(await response.json()),
    receivedAtMonotonicMs: performance.now(),
  };
}

function validateAdmission(value: unknown): AdmissionResponse {
  if (!isRecord(value)) throw new Error('Admission returned invalid JSON');
  const {
    expiresAt,
    protocol,
    resetAt,
    sessionLifetimeMs,
    token,
    webSocketPath,
  } = value;
  if (
    typeof expiresAt !== 'string' ||
    Number.isNaN(Date.parse(expiresAt)) ||
    typeof resetAt !== 'string' ||
    Number.isNaN(Date.parse(resetAt)) ||
    protocol !== applicationProtocol ||
    !Number.isSafeInteger(sessionLifetimeMs) ||
    (sessionLifetimeMs as number) < 1 ||
    (sessionLifetimeMs as number) > 300_000 ||
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

function remainingSessionLifetimeMs(admission: TimedAdmissionResponse): number {
  return Math.max(
    0,
    admission.sessionLifetimeMs -
      (performance.now() - admission.receivedAtMonotonicMs),
  );
}

function startCountdown(admission: TimedAdmissionResponse): void {
  if (countdownTimer) clearInterval(countdownTimer);
  countdown.hidden = false;
  const render = () => {
    const remaining = Math.ceil(remainingSessionLifetimeMs(admission) / 1_000);
    const minutes = Math.floor(remaining / 60);
    const seconds = String(remaining % 60).padStart(2, '0');
    countdown.textContent = `Shared reset in ${String(minutes)}:${seconds}`;
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
  message = 'Session ended or the shared environment reset. You may start again.',
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

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!turnstileScriptState) {
    turnstileScriptState = createTurnstileScriptState();
    document.head.append(turnstileScriptState.element);
  }
  return waitForTurnstile(turnstileScriptState.loaded);
}

function createTurnstileScriptState(): TurnstileScriptState {
  const element = document.createElement('script');
  element.src = turnstileScriptUrl;
  element.async = true;
  element.referrerPolicy = 'no-referrer';
  const loaded = new Promise<TurnstileApi>((resolve, reject) => {
    const cleanup = () => {
      element.removeEventListener('load', onLoad);
      element.removeEventListener('error', onError);
    };
    const onLoad = () => {
      cleanup();
      if (!window.turnstile) {
        discardTurnstileScript(element);
        reject(new Error('Human verification loaded an invalid response.'));
        return;
      }
      resolve(window.turnstile);
    };
    const onError = () => {
      cleanup();
      discardTurnstileScript(element);
      reject(new Error('Human verification could not be loaded.'));
    };
    element.addEventListener('load', onLoad);
    element.addEventListener('error', onError);
  });
  return { element, loaded };
}

function discardTurnstileScript(element: HTMLScriptElement): void {
  if (turnstileScriptState?.element === element) {
    turnstileScriptState = undefined;
  }
  element.remove();
}

function waitForTurnstile(
  loaded: Promise<TurnstileApi>,
): Promise<TurnstileApi> {
  return new Promise<TurnstileApi>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Human verification did not load in time.'));
    }, turnstileLoadTimeoutMs);
    void loaded.then(
      (turnstile) => {
        clearTimeout(timeout);
        resolve(turnstile);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(
          error instanceof Error
            ? error
            : new Error('Human verification could not be loaded.'),
        );
      },
    );
  });
}

async function completeHumanCheck(): Promise<string> {
  turnstilePanel.hidden = false;
  const turnstile = await loadTurnstile();
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const succeed = (token: string) => {
      if (settled) return;
      settled = true;
      resolve(token);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };
    widgetId = turnstile.render(turnstileMount, {
      action: turnstileAction,
      appearance: 'always',
      callback: succeed,
      'error-callback': () => {
        fail('Human verification failed to run. Please try again.');
        return true;
      },
      'expired-callback': () =>
        fail('Human verification expired. Please try again.'),
      'response-field': false,
      sitekey: turnstileSiteKey,
      size: 'flexible',
      theme: 'auto',
      'timeout-callback': () =>
        fail('Human verification timed out. Please try again.'),
      'unsupported-callback': () =>
        fail('This browser cannot run human verification.'),
    });
  });
}

function removeTurnstile(): void {
  if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
  widgetId = undefined;
  turnstileMount.replaceChildren();
  turnstilePanel.hidden = true;
}

async function startRemoteDemo(): Promise<void> {
  if (starting || activeTerminal) return;
  starting = true;
  startButton.disabled = true;
  updateStatus('Complete the human check to start the demo…', 'loading');
  let startupTerminal: LitShellTerminal | undefined;
  try {
    const origin = configuredOrigin();
    const turnstileToken = await completeHumanCheck();
    updateStatus(
      'Verified. Waking the free service; this can take about a minute…',
      'loading',
    );
    await wakeService(origin);
    updateStatus('Requesting a place in the shared container…', 'loading');
    const admission = await requestAdmission(origin, turnstileToken);
    removeTurnstile();
    if (remainingSessionLifetimeMs(admission) <= 0) {
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
    terminal.setAttribute('aria-label', 'Shared remote shell terminal');
    terminal.addEventListener('disconnect', () => sessionEnded(terminal));
    terminal.addEventListener('exit', () => {
      sessionEnded(
        terminal,
        'The shell process exited. You may complete a new check and start again.',
      );
    });
    terminal.addEventListener('session-closed', () => sessionEnded(terminal));
    terminal.addEventListener('error', (event: Event) => {
      const detail =
        'detail' in event && isRecord(event.detail) ? event.detail : undefined;
      const message =
        detail?.error instanceof Error
          ? detail.error.message
          : 'The remote terminal reported a protocol error.';
      sessionFailed(terminal, message);
    });

    startupTerminal = terminal;
    activeTerminal = terminal;
    mount.replaceChildren(terminal);
    await terminal.connect();
    if (activeTerminal !== terminal) {
      releaseTerminal(terminal);
      return;
    }
    terminal.clearProtocols();
    await terminal.spawn({ allowJoin: false, cols: 80, rows: 24 });
    if (activeTerminal !== terminal) {
      releaseTerminal(terminal);
      return;
    }
    terminal.shadowRoot
      ?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      ?.setAttribute('aria-label', 'Remote shell terminal input');
    endButton.hidden = false;
    startCountdown(admission);
    updateStatus('Connected to the shared disposable container.', 'ready');
  } catch (error) {
    if (startupTerminal && activeTerminal !== startupTerminal) return;
    removeTurnstile();
    if (startupTerminal) releaseTerminal(startupTerminal);
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
  sessionEnded(terminal, 'Session ended by you. You may start a new one.');
  endButton.disabled = false;
});

document.addEventListener('securitypolicyviolation', (event) => {
  document.documentElement.dataset.cspViolation = event.violatedDirective;
  const message = 'The browser blocked a resource required by the demo.';
  if (activeTerminal) sessionFailed(activeTerminal, message);
  else updateStatus(message, 'error');
});

if (window.top !== window.self) {
  startButton.disabled = true;
  updateStatus(
    'The real shell demo cannot run inside an embedded frame.',
    'error',
  );
} else if (!remoteOrigin || !turnstileSiteKey) {
  startButton.disabled = true;
  updateStatus(
    'The remote service and human verification are not connected yet. The safe simulator remains available.',
    'idle',
  );
}
