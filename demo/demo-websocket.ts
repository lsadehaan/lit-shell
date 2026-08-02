/**
 * A deterministic, in-browser lit-shell protocol simulator.
 *
 * This module never opens a native socket and never evaluates or executes
 * terminal input. It exists solely so the static GitHub Pages demo can drive
 * the real lit-shell client and UI without a server.
 */

export const DEMO_WEBSOCKET_URL = 'demo://terminal';

const SESSION_ID = 'browser-demo-session';
const DEMO_SHELL = '/bin/lit-shell-demo';
const DEMO_CWD = '/demo';
const CRLF = '\r\n';
const MAX_LINE_LENGTH = 512;
const MAX_HISTORY_LENGTH = 50;

const PROMPT = '\u001b[1;32mguest@lit-shell\u001b[0m:\u001b[1;34m~\u001b[0m$ ';

const WELCOME = [
  '\u001b[1;36mlit-shell.js browser demo\u001b[0m',
  '\u001b[1;33mSAFE SIMULATION — no server, PTY, container, or OS commands.\u001b[0m',
  'Input is handled by a deterministic in-memory command allowlist.',
  'Type "help" to see the available demo commands.',
  '',
].join(CRLF);

const HELP = [
  'Available simulated commands:',
  '  help              Show this command list',
  '  about             Explain what this demo exercises',
  '  pwd               Print the simulated working directory',
  '  whoami            Print the simulated user',
  '  ls                List the simulated files',
  '  cat README.md     Read the simulated README',
  '  echo [text]       Echo text without shell expansion',
  "  date              Print the demo's fixed clock",
  '  history           Show commands entered in this tab',
  '  clear             Clear the terminal display',
].join(CRLF);

const ABOUT = [
  'This page bundles the real Lit web component and TerminalClient.',
  'A small WebSocket-compatible object simulates only the lit-shell protocol.',
  'Nothing you type is sent over the network or passed to a command runner.',
].join(CRLF);

const README = [
  '# lit-shell.js browser demo',
  '',
  'This is a static, safe simulation of the terminal protocol.',
  'Run the repository examples locally to exercise a real PTY-backed server.',
].join(CRLF);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestIdFrom(message: JsonRecord): string | undefined {
  return typeof message.requestId === 'string' ? message.requestId : undefined;
}

function dimension(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(2, Math.min(1_000, Math.trunc(value)));
}

function createCloseEvent(code: number, reason: string): CloseEvent {
  if (typeof CloseEvent === 'function') {
    return new CloseEvent('close', { code, reason, wasClean: true });
  }

  const event = new Event('close') as CloseEvent;
  Object.defineProperties(event, {
    code: { configurable: true, enumerable: true, value: code },
    reason: { configurable: true, enumerable: true, value: reason },
    wasClean: { configurable: true, enumerable: true, value: true },
  });
  return event;
}

/**
 * Minimal line editor and allowlisted fake shell used by DemoWebSocket.
 * Outputs VT sequences because the consumer is the real xterm.js UI.
 */
export class DemoShell {
  private line: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private escapeSequence = '';
  private ignoreNextLineFeed = false;

  start(): string {
    this.line = [];
    this.cursor = 0;
    this.escapeSequence = '';
    this.ignoreNextLineFeed = false;
    this.historyIndex = this.history.length;
    return `${WELCOME}${PROMPT}`;
  }

  write(data: string): string {
    const output: string[] = [];

    for (const character of data) {
      if (this.consumeEscapeSequence(character, output)) continue;

      if (character === '\u001b') {
        this.escapeSequence = character;
        continue;
      }

      if (character === '\n' && this.ignoreNextLineFeed) {
        this.ignoreNextLineFeed = false;
        continue;
      }
      if (character !== '\n') this.ignoreNextLineFeed = false;

      switch (character) {
        case '\r':
          this.ignoreNextLineFeed = true;
          this.submit(output);
          break;
        case '\n':
          this.submit(output);
          break;
        case '\u0003':
          this.cancel(output);
          break;
        case '\u0001':
          this.moveCursor(0, output);
          break;
        case '\u0005':
          this.moveCursor(this.line.length, output);
          break;
        case '\u000b':
          if (this.cursor < this.line.length) {
            this.line.splice(this.cursor);
            this.redraw(output);
          }
          break;
        case '\u0015':
          if (this.cursor > 0) {
            this.line.splice(0, this.cursor);
            this.cursor = 0;
            this.redraw(output);
          }
          break;
        case '\u0017':
          this.deletePreviousWord(output);
          break;
        case '\u000c':
          output.push('\u001b[2J\u001b[H');
          this.redraw(output);
          break;
        case '\b':
        case '\u007f':
          this.backspace(output);
          break;
        case '\u0004':
          this.deleteAtCursor(output);
          break;
        case '\t':
          output.push('\u0007');
          break;
        default:
          this.insertPrintable(character, output);
      }
    }

    return output.join('');
  }

  private consumeEscapeSequence(character: string, output: string[]): boolean {
    if (!this.escapeSequence) return false;

    this.escapeSequence += character;
    if (this.escapeSequence.length === 2 && character !== '[') {
      this.escapeSequence = '';
      return true;
    }

    const finalCodePoint = character.codePointAt(0) ?? 0;
    const complete =
      this.escapeSequence.length > 2 &&
      finalCodePoint >= 0x40 &&
      finalCodePoint <= 0x7e;

    if (complete) {
      const sequence = this.escapeSequence;
      this.escapeSequence = '';
      this.handleEscapeSequence(sequence, output);
    } else if (this.escapeSequence.length > 16) {
      this.escapeSequence = '';
    }

    return true;
  }

  private handleEscapeSequence(sequence: string, output: string[]): void {
    switch (sequence) {
      case '\u001b[A':
        this.recallHistory(-1, output);
        break;
      case '\u001b[B':
        this.recallHistory(1, output);
        break;
      case '\u001b[C':
        this.moveCursor(Math.min(this.cursor + 1, this.line.length), output);
        break;
      case '\u001b[D':
        this.moveCursor(Math.max(this.cursor - 1, 0), output);
        break;
      case '\u001b[H':
      case '\u001b[1~':
        this.moveCursor(0, output);
        break;
      case '\u001b[F':
      case '\u001b[4~':
        this.moveCursor(this.line.length, output);
        break;
      case '\u001b[3~':
        this.deleteAtCursor(output);
        break;
      default:
        // Unknown terminal escape sequences are intentionally ignored.
        break;
    }
  }

  private insertPrintable(character: string, output: string[]): void {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return;
    if (this.line.length >= MAX_LINE_LENGTH) {
      output.push('\u0007');
      return;
    }

    const append = this.cursor === this.line.length;
    this.line.splice(this.cursor, 0, character);
    this.cursor += 1;
    if (append) output.push(character);
    else this.redraw(output);
  }

  private backspace(output: string[]): void {
    if (this.cursor === 0) {
      output.push('\u0007');
      return;
    }

    const removedFromEnd = this.cursor === this.line.length;
    this.line.splice(this.cursor - 1, 1);
    this.cursor -= 1;
    if (removedFromEnd) output.push('\b \b');
    else this.redraw(output);
  }

  private deleteAtCursor(output: string[]): void {
    if (this.cursor >= this.line.length) {
      output.push('\u0007');
      return;
    }
    this.line.splice(this.cursor, 1);
    this.redraw(output);
  }

  private deletePreviousWord(output: string[]): void {
    if (this.cursor === 0) {
      output.push('\u0007');
      return;
    }

    let start = this.cursor;
    while (start > 0 && this.line[start - 1] === ' ') start -= 1;
    while (start > 0 && this.line[start - 1] !== ' ') start -= 1;
    this.line.splice(start, this.cursor - start);
    this.cursor = start;
    this.redraw(output);
  }

  private moveCursor(position: number, output: string[]): void {
    if (position === this.cursor) return;
    this.cursor = position;
    this.redraw(output);
  }

  private recallHistory(direction: -1 | 1, output: string[]): void {
    if (this.history.length === 0) {
      output.push('\u0007');
      return;
    }

    const next = Math.max(
      0,
      Math.min(this.history.length, this.historyIndex + direction),
    );
    if (next === this.historyIndex) {
      output.push('\u0007');
      return;
    }

    this.historyIndex = next;
    this.line =
      next === this.history.length ? [] : Array.from(this.history[next] ?? '');
    this.cursor = this.line.length;
    this.redraw(output);
  }

  private cancel(output: string[]): void {
    output.push(`^C${CRLF}${PROMPT}`);
    this.line = [];
    this.cursor = 0;
    this.historyIndex = this.history.length;
  }

  private submit(output: string[]): void {
    const command = this.line.join('').trim();
    output.push(CRLF);

    if (command) {
      if (this.history.at(-1) !== command) this.history.push(command);
      if (this.history.length > MAX_HISTORY_LENGTH) this.history.shift();
    }

    this.line = [];
    this.cursor = 0;
    this.historyIndex = this.history.length;

    const result = this.execute(command);
    if (result.clear) output.push('\u001b[2J\u001b[H');
    else if (result.text) output.push(result.text, CRLF);
    output.push(PROMPT);
  }

  private execute(command: string): { clear?: boolean; text?: string } {
    if (!command) return {};
    if (command === 'help') return { text: HELP };
    if (command === 'about') return { text: ABOUT };
    if (command === 'pwd') return { text: DEMO_CWD };
    if (command === 'whoami') return { text: 'visitor' };
    if (command === 'ls') return { text: 'README.md  examples/  src/' };
    if (command === 'cat README.md') return { text: README };
    if (command === 'date') {
      return { text: '2026-01-01T00:00:00.000Z (fixed demo clock)' };
    }
    if (command === 'history') {
      return {
        text: this.history
          .map((entry, index) => `${String(index + 1).padStart(3)}  ${entry}`)
          .join(CRLF),
      };
    }
    if (command === 'clear') return { clear: true };

    const echo = /^echo(?:\s+(.*))?$/.exec(command);
    if (echo) return { text: echo[1] ?? '' };

    const commandName = command.split(/\s+/, 1)[0] ?? command;
    return {
      text: [
        `Command "${commandName}" is not available in this browser demo.`,
        'No command was executed. Type "help" for the safe allowlist.',
      ].join(CRLF),
    };
  }

  private redraw(output: string[]): void {
    // This tiny editor counts Unicode code points, not terminal display cells;
    // wide glyph cursor placement is intentionally outside the demo's scope.
    output.push('\r\u001b[2K', PROMPT, this.line.join(''));
    const cellsFromEnd = this.line.length - this.cursor;
    if (cellsFromEnd > 0) output.push(`\u001b[${cellsFromEnd}D`);
  }
}

/** A WebSocket-compatible, zero-network transport for the browser demo. */
export class DemoWebSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSING = 2 as const;
  static readonly CLOSED = 3 as const;

  readonly CONNECTING = DemoWebSocket.CONNECTING;
  readonly OPEN = DemoWebSocket.OPEN;
  readonly CLOSING = DemoWebSocket.CLOSING;
  readonly CLOSED = DemoWebSocket.CLOSED;

  readonly url: string;
  readonly protocol = '';
  readonly extensions = '';
  readonly bufferedAmount = 0;
  binaryType: BinaryType = 'blob';
  readyState: 0 | 1 | 2 | 3 = DemoWebSocket.CONNECTING;

  onclose: WebSocket['onclose'] = null;
  onerror: WebSocket['onerror'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onopen: WebSocket['onopen'] = null;

  private readonly shell = new DemoShell();
  private sessionActive = false;
  private cols = 80;
  private rows = 24;

  constructor(url: string | URL, protocols?: string | string[]) {
    super();
    const normalizedUrl = String(url);
    if (normalizedUrl !== DEMO_WEBSOCKET_URL) {
      throw new DOMException(
        `The static demo only permits ${DEMO_WEBSOCKET_URL}`,
        'SecurityError',
      );
    }
    if (
      typeof protocols === 'string' ? protocols.length > 0 : protocols?.length
    ) {
      throw new DOMException(
        'The static demo does not support WebSocket subprotocols',
        'SyntaxError',
      );
    }

    this.url = normalizedUrl;
    queueMicrotask(() => this.open());
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== DemoWebSocket.OPEN) {
      throw new DOMException('WebSocket is not open', 'InvalidStateError');
    }
    if (typeof data !== 'string') {
      throw new TypeError('The demo protocol accepts text messages only');
    }

    queueMicrotask(() => {
      if (this.readyState === DemoWebSocket.OPEN)
        this.handleClientMessage(data);
    });
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= DemoWebSocket.CLOSING) return;
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException(
        'Invalid WebSocket close code',
        'InvalidAccessError',
      );
    }
    if (new TextEncoder().encode(reason).byteLength > 123) {
      throw new DOMException(
        'WebSocket close reason exceeds 123 bytes',
        'SyntaxError',
      );
    }

    this.readyState = DemoWebSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = DemoWebSocket.CLOSED;
      this.emit(createCloseEvent(code, reason));
    });
  }

  private open(): void {
    if (this.readyState !== DemoWebSocket.CONNECTING) return;
    this.readyState = DemoWebSocket.OPEN;
    this.emit(new Event('open'));
    this.emitMessage({
      type: 'serverInfo',
      info: {
        localEnabled: true,
        dockerEnabled: false,
        allowedShells: [DEMO_SHELL],
        defaultShell: DEMO_SHELL,
      },
    });
  }

  private handleClientMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.protocolError(undefined, 'The demo received invalid JSON');
      return;
    }

    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      this.protocolError(undefined, 'The demo received an invalid message');
      return;
    }

    switch (parsed.type) {
      case 'listSessions':
        this.emitMessage({
          type: 'sessionList',
          requestId: requestIdFrom(parsed),
          sessions: [],
        });
        break;
      case 'listContainers':
        this.emitMessage({
          type: 'containerList',
          requestId: requestIdFrom(parsed),
          containers: [],
        });
        break;
      case 'spawn':
        this.spawn(parsed);
        break;
      case 'data':
        this.receiveTerminalData(parsed);
        break;
      case 'resize':
        this.resize(parsed);
        break;
      case 'close':
        this.closeSession(parsed);
        break;
      case 'join':
        this.protocolError(
          requestIdFrom(parsed),
          'No demo sessions are joinable',
        );
        break;
      case 'leave':
        this.leaveSession(parsed);
        break;
      default:
        this.protocolError(
          requestIdFrom(parsed),
          `Unsupported demo protocol message: ${parsed.type}`,
        );
    }
  }

  private spawn(message: JsonRecord): void {
    const requestId = requestIdFrom(message);
    if (this.sessionActive) {
      this.protocolError(requestId, 'A demo session is already active');
      return;
    }

    const options = isRecord(message.options) ? message.options : {};
    this.cols = dimension(options.cols, 80);
    this.rows = dimension(options.rows, 24);
    this.sessionActive = true;
    this.emitMessage({
      type: 'spawned',
      requestId,
      sessionId: SESSION_ID,
      shell: DEMO_SHELL,
      cwd: DEMO_CWD,
      cols: this.cols,
      rows: this.rows,
    });
    const welcome = this.shell.start();
    setTimeout(() => {
      if (this.readyState === DemoWebSocket.OPEN && this.sessionActive) {
        this.emitTerminalData(welcome);
      }
    }, 0);
  }

  private receiveTerminalData(message: JsonRecord): void {
    if (!this.hasActiveSession(message)) return;
    if (typeof message.data !== 'string') {
      this.protocolError(requestIdFrom(message), 'Terminal data must be text');
      return;
    }

    const response = this.shell.write(message.data);
    if (response) this.emitTerminalData(response);
  }

  private resize(message: JsonRecord): void {
    if (!this.hasActiveSession(message)) return;
    this.cols = dimension(message.cols, this.cols);
    this.rows = dimension(message.rows, this.rows);
  }

  private closeSession(message: JsonRecord): void {
    if (!this.hasActiveSession(message)) return;
    this.sessionActive = false;
    this.emitMessage({ type: 'exit', sessionId: SESSION_ID, exitCode: 0 });
  }

  private leaveSession(message: JsonRecord): void {
    if (!this.hasActiveSession(message)) return;
    this.sessionActive = false;
    this.emitMessage({ type: 'left', sessionId: SESSION_ID });
  }

  private hasActiveSession(message: JsonRecord): boolean {
    if (!this.sessionActive || message.sessionId !== SESSION_ID) {
      this.protocolError(requestIdFrom(message), 'No matching demo session');
      return false;
    }
    return true;
  }

  private emitTerminalData(data: string): void {
    this.emitMessage({ type: 'data', sessionId: SESSION_ID, data });
  }

  private protocolError(requestId: string | undefined, error: string): void {
    this.emitMessage({ type: 'error', requestId, error });
  }

  private emitMessage(message: JsonRecord): void {
    this.emit(
      new MessageEvent('message', {
        data: JSON.stringify(message),
        origin: DEMO_WEBSOCKET_URL,
      }),
    );
  }

  private emit(event: Event): void {
    this.dispatchEvent(event);
    switch (event.type) {
      case 'open':
        this.onopen?.call(this, event);
        break;
      case 'message':
        this.onmessage?.call(this, event as MessageEvent);
        break;
      case 'close':
        this.onclose?.call(this, event as CloseEvent);
        break;
      case 'error':
        this.onerror?.call(this, event);
        break;
    }
  }
}

/** Replace the browser WebSocket constructor with the demo-only transport. */
export function installDemoWebSocket(): void {
  globalThis.WebSocket = DemoWebSocket;
}
