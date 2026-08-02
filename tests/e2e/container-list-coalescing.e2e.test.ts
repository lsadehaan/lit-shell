import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import {
  startTestServer,
  waitUntil,
  type StartedTestServer,
  type WireMessage,
} from './protocol-harness.js';

type DockerCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

describe('TerminalServer container-list process bounds (black-box)', () => {
  let server: StartedTestServer | undefined;
  let callbacks: DockerCallback[];

  beforeEach(() => {
    callbacks = [];
    execFileMock.mockReset();
    execFileMock.mockImplementation((...arguments_: unknown[]) => {
      callbacks.push(arguments_[3] as DockerCallback);
      return undefined;
    });
  });

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  function isResponse(message: WireMessage, requestId: string): boolean {
    return message.type === 'containerList' && message.requestId === requestId;
  }

  it('coalesces a burst into one bounded docker process and caches success', async () => {
    server = await startTestServer({ allowDockerExec: true });
    const first = await server.connect();
    const second = await server.connect();
    const firstFrom = first.mark();
    const secondFrom = second.mark();

    first.send({ type: 'listContainers', requestId: 'first' });
    second.send({ type: 'listContainers', requestId: 'second' });
    await waitUntil(() => execFileMock.mock.calls.length === 1, {
      description: 'one coalesced docker ps process',
    });

    expect(execFileMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      }),
    );
    callbacks[0]?.(
      null,
      'malformed\n' +
        'abc123\tdev-shell\timage:latest\tUp 1 minute\trunning\n' +
        'def456\tmystery\timage:old\tUnknown\tnew-state\n',
      '',
    );

    const [firstResponse, secondResponse] = await Promise.all([
      first.waitFor((message) => isResponse(message, 'first'), {
        from: firstFrom,
      }),
      second.waitFor((message) => isResponse(message, 'second'), {
        from: secondFrom,
      }),
    ]);
    expect(firstResponse.containers).toEqual(secondResponse.containers);
    expect(firstResponse.containers).toEqual([
      expect.objectContaining({
        id: 'abc123',
        name: 'dev-shell',
        state: 'running',
      }),
      expect.objectContaining({
        id: 'def456',
        name: 'mystery',
        state: 'unknown',
      }),
    ]);

    const cachedFrom = first.mark();
    first.send({ type: 'listContainers', requestId: 'cached' });
    await first.waitFor((message) => isResponse(message, 'cached'), {
      from: cachedFrom,
    });
    expect(execFileMock).toHaveBeenCalledOnce();
  });

  it('coalesces and rate-limits failures before allowing a later retry', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    server = await startTestServer({ allowDockerExec: true });
    const first = await server.connect();
    const second = await server.connect();
    const firstFrom = first.mark();
    const secondFrom = second.mark();

    first.send({ type: 'listContainers', requestId: 'failed-first' });
    second.send({ type: 'listContainers', requestId: 'failed-second' });
    await waitUntil(() => execFileMock.mock.calls.length === 1, {
      description: 'one failing docker ps process',
    });
    callbacks[0]?.(new Error('docker unavailable'), '', 'failure');

    const failed = await Promise.all([
      first.waitFor((message) => isResponse(message, 'failed-first'), {
        from: firstFrom,
      }),
      second.waitFor((message) => isResponse(message, 'failed-second'), {
        from: secondFrom,
      }),
    ]);
    expect(failed.map((message) => message.containers)).toEqual([[], []]);

    const cooldownFrom = first.mark();
    first.send({ type: 'listContainers', requestId: 'cooldown' });
    const cooldown = await first.waitFor(
      (message) => isResponse(message, 'cooldown'),
      { from: cooldownFrom },
    );
    expect(cooldown.containers).toEqual([]);
    expect(execFileMock).toHaveBeenCalledOnce();

    dateNow.mockReturnValue(11_001);
    const retryFrom = first.mark();
    first.send({ type: 'listContainers', requestId: 'retry' });
    await waitUntil(() => execFileMock.mock.calls.length === 2, {
      description: 'a fresh docker ps retry',
    });
    callbacks[1]?.(null, 'retry1\trecovered\timage\tUp\trunning\n', '');

    const retry = await first.waitFor(
      (message) => isResponse(message, 'retry'),
      { from: retryFrom },
    );
    expect(retry.containers).toEqual([
      expect.objectContaining({ id: 'retry1', name: 'recovered' }),
    ]);
  });
});
