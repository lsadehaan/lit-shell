import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startTestServer, type StartedTestServer } from './protocol-harness.js';

const ptySpawn = vi.hoisted(() => vi.fn());

vi.mock('node-pty', () => ({ spawn: ptySpawn }));

function createPtyStub(): {
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  resize(cols: number, rows: number): void;
  write(data: string): void;
} {
  return {
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
  };
}

describe('TerminalServer local identity wiring', () => {
  let server: StartedTestServer | undefined;

  beforeEach(() => {
    ptySpawn.mockReset();
    ptySpawn.mockImplementation(() => createPtyStub());
  });

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  it('passes the fixed identity to local PTYs and never to Docker PTYs', async () => {
    server = await startTestServer({
      allowDockerExec: true,
      localUid: 12_345,
      localGid: 23_456,
    });
    const client = await server.connect();

    let from = client.mark();
    client.send({ type: 'spawn' });
    await client.waitForType('spawned', { from });

    from = client.mark();
    client.send({ type: 'spawn', options: { container: 'shared-demo' } });
    await client.waitForType('spawned', { from });

    const calls = ptySpawn.mock.calls as Array<
      [string, string[], Record<string, unknown>]
    >;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[2]).toMatchObject({ uid: 12_345, gid: 23_456 });
    expect(calls[1]?.[2]).not.toHaveProperty('uid');
    expect(calls[1]?.[2]).not.toHaveProperty('gid');
  });
});
