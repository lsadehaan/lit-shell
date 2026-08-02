import { describe, expect, it, vi } from 'vitest';
import {
  DEMO_WEBSOCKET_URL,
  DemoShell,
  DemoWebSocket,
} from '../demo/demo-websocket.js';

type ServerMessage = Record<string, any>;

function stripTerminalControlSequences(value: string): string {
  return value
    .replaceAll(new RegExp(String.raw`\x1b\[[0-?]*[ -/]*[@-~]`, 'g'), '')
    .replaceAll('\u0007', '')
    .replaceAll('\b', '');
}

async function openSocket(): Promise<{
  socket: DemoWebSocket;
  messages: ServerMessage[];
}> {
  const socket = new DemoWebSocket(DEMO_WEBSOCKET_URL);
  const messages: ServerMessage[] = [];
  socket.addEventListener('message', (event) => {
    messages.push(JSON.parse(String((event as MessageEvent).data)));
  });
  await new Promise<void>((resolve) => {
    socket.addEventListener('open', () => resolve(), { once: true });
  });
  return { socket, messages };
}

async function flushMessages(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('DemoShell', () => {
  it('runs only the documented deterministic command allowlist', () => {
    const shell = new DemoShell();
    expect(shell.start()).toContain('SAFE SIMULATION');

    const output = stripTerminalControlSequences(
      shell.write('pwd\recho hello, demo\rdate\r'),
    );
    expect(output).toContain('/demo');
    expect(output).toContain('hello, demo');
    expect(output).toContain('2026-01-01T00:00:00.000Z (fixed demo clock)');
  });

  it('rejects unknown and dangerous-looking commands without executing them', () => {
    const shell = new DemoShell();
    shell.start();

    const output = stripTerminalControlSequences(shell.write('rm -rf /\r'));
    expect(output).toContain('Command "rm" is not available');
    expect(output).toContain('No command was executed');
  });

  it('supports cursor edits, cancellation, and history recall', () => {
    const shell = new DemoShell();
    shell.start();

    const edited = stripTerminalControlSequences(
      shell.write('ecoh\u001b[D\u001b[3~ho edited\r'),
    );
    expect(edited).toContain('edited');
    expect(edited).not.toContain('Command "ecoh"');

    const cancelled = stripTerminalControlSequences(shell.write('nope\u0003'));
    expect(cancelled).toContain('^C');
    expect(cancelled).not.toContain('not available');

    const recalled = stripTerminalControlSequences(shell.write('\u001b[A\r'));
    expect(recalled).toContain('edited');
  });

  it('handles CRLF as one submission and ignores terminal control injection', () => {
    const shell = new DemoShell();
    shell.start();

    const output = stripTerminalControlSequences(
      shell.write('whoami\r\n\u001b]0;unsafe\u0007pwd\r'),
    );
    expect(output.match(/visitor/g)).toHaveLength(1);
    expect(output).toContain('Command "0;unsafepwd" is not available');
  });

  it('bounds input and strips control characters before command handling', () => {
    const shell = new DemoShell();
    shell.start();

    const echoed = shell.write(`${'x'.repeat(600)}\u0000\u0006`);
    expect(echoed.match(/x/g)).toHaveLength(512);
    expect(echoed).not.toContain('\u0000');
    expect(echoed).toContain('\u0007');
  });
});

describe('DemoWebSocket', () => {
  it('accepts only the exact in-memory demo endpoint', () => {
    expect(() => new DemoWebSocket('wss://example.test/terminal')).toThrow(
      'only permits demo://terminal',
    );
    expect(() => new DemoWebSocket('demo://terminal/')).toThrow(
      'only permits demo://terminal',
    );
  });

  it('speaks the client protocol with request correlation', async () => {
    const { socket, messages } = await openSocket();
    expect(messages[0]).toMatchObject({
      type: 'serverInfo',
      info: { localEnabled: true, dockerEnabled: false },
    });

    socket.send(
      JSON.stringify({
        type: 'listSessions',
        requestId: 'list-1',
      }),
    );
    socket.send(
      JSON.stringify({
        type: 'listContainers',
        requestId: 'containers-1',
      }),
    );
    socket.send(
      JSON.stringify({
        type: 'spawn',
        requestId: 'spawn-1',
        options: { cols: 120, rows: 30 },
      }),
    );
    await flushMessages();

    expect(messages).toContainEqual({
      type: 'sessionList',
      requestId: 'list-1',
      sessions: [],
    });
    expect(messages).toContainEqual({
      type: 'containerList',
      requestId: 'containers-1',
      containers: [],
    });
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'spawned',
        requestId: 'spawn-1',
        sessionId: 'browser-demo-session',
        shell: '/bin/lit-shell-demo',
        cwd: '/demo',
        cols: 120,
        rows: 30,
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'data',
        sessionId: 'browser-demo-session',
      }),
    );
  });

  it('routes terminal input through the allowlisted shell', async () => {
    const { socket, messages } = await openSocket();
    socket.send(JSON.stringify({ type: 'spawn', requestId: 'spawn-1' }));
    await flushMessages();
    messages.length = 0;

    socket.send(
      JSON.stringify({
        type: 'data',
        sessionId: 'browser-demo-session',
        data: 'help\r',
      }),
    );
    socket.send(
      JSON.stringify({
        type: 'data',
        sessionId: 'browser-demo-session',
        data: 'curl https://example.test\r',
      }),
    );
    await flushMessages();

    const output = stripTerminalControlSequences(
      messages.map((message) => String(message.data ?? '')).join(''),
    );
    expect(output).toContain('Available simulated commands');
    expect(output).toContain('Command "curl" is not available');
    expect(output).toContain('No command was executed');
  });

  it('validates session identity and closes without reconnecting', async () => {
    const { socket, messages } = await openSocket();
    socket.send(JSON.stringify({ type: 'spawn', requestId: 'spawn-1' }));
    await flushMessages();

    socket.send(
      JSON.stringify({
        type: 'data',
        sessionId: 'wrong-session',
        data: 'help\r',
      }),
    );
    await flushMessages();
    expect(messages.at(-1)).toMatchObject({
      type: 'error',
      error: 'No matching demo session',
    });

    socket.send(
      JSON.stringify({
        type: 'close',
        sessionId: 'browser-demo-session',
      }),
    );
    await flushMessages();
    expect(messages.at(-1)).toEqual({
      type: 'exit',
      sessionId: 'browser-demo-session',
      exitCode: 0,
    });

    socket.send(JSON.stringify({ type: 'spawn', requestId: 'spawn-2' }));
    await flushMessages();
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'spawned',
        requestId: 'spawn-2',
        sessionId: 'browser-demo-session',
      }),
    );

    const closed = vi.fn();
    socket.addEventListener('close', closed);
    socket.close(1000, 'test complete');
    await flushMessages();
    expect(socket.readyState).toBe(DemoWebSocket.CLOSED);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('returns protocol errors for malformed input without throwing', async () => {
    const { socket, messages } = await openSocket();

    socket.send('{invalid json');
    socket.send(JSON.stringify({ nope: true }));
    socket.send(
      JSON.stringify({ type: 'unknown', requestId: 'unsupported-1' }),
    );
    await flushMessages();

    expect(messages.slice(-3)).toEqual([
      { type: 'error', error: 'The demo received invalid JSON' },
      { type: 'error', error: 'The demo received an invalid message' },
      {
        type: 'error',
        requestId: 'unsupported-1',
        error: 'Unsupported demo protocol message: unknown',
      },
    ]);
  });
});
