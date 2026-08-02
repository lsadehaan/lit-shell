import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { TerminalServer } from '../../src/server/index.js';
import { expectProtocolError } from './protocol-assertions.js';
import { startTestServer, type StartedTestServer } from './protocol-harness.js';

describe('TerminalServer Docker input validation (black-box)', () => {
  let server: StartedTestServer | undefined;

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  async function expectInvalidSpawnOptions(
    options: Record<string, unknown>,
    expectedError: RegExp,
  ): Promise<void> {
    server = await startTestServer({ allowDockerExec: true });
    const client = await server.connect();
    const requestId = `invalid-docker-option-${randomUUID()}`;
    const from = client.mark();

    client.send({ type: 'spawn', requestId, options });

    const error = await expectProtocolError(client, from);
    expect(error).toMatchObject({ requestId });
    expect(error.error).toEqual(expect.stringMatching(expectedError));
    expect(server.terminal.getStats()).toMatchObject({
      sessionCount: 0,
      clientCount: 0,
    });
  }

  it.each([
    '-danger',
    '--privileged',
    '.hidden',
    '_hidden',
    'team/container',
    'image:tag',
    'white space',
    'line\nbreak',
  ])('rejects an invalid container identifier: %j', async (container) => {
    await expectInvalidSpawnOptions(
      { container },
      /container must be a valid Docker container name or ID/i,
    );
  });

  it.each([
    '--privileged',
    '-1',
    ':root',
    'root:',
    'root:staff:extra',
    'root staff',
    'root/../../host',
  ])('rejects an unsafe container user: %j', async (containerUser) => {
    await expectInvalidSpawnOptions(
      { container: 'valid-container', containerUser },
      /containerUser must be a valid user or user:group/i,
    );
  });

  it.each([
    'work',
    '../work',
    'C:\\work',
    '--workdir',
    'relative/path',
    '/safe\0escape',
  ])(
    'rejects an unsafe container working directory: %j',
    async (containerCwd) => {
      await expectInvalidSpawnOptions(
        { container: 'valid-container', containerCwd },
        /containerCwd must be an absolute POSIX path/i,
      );
    },
  );

  it.each([
    'BAD-KEY',
    '1STARTS_WITH_DIGIT',
    'HAS=EQUALS',
    'HAS.DOT',
    'WITH SPACE',
  ])('rejects a non-portable environment key: %j', async (key) => {
    await expectInvalidSpawnOptions(
      {
        container: 'valid-container',
        env: { [key]: 'value' },
      },
      /env keys must use portable identifier syntax/i,
    );
  });

  it('rejects environment values containing NUL bytes', async () => {
    await expectInvalidSpawnOptions(
      {
        container: 'valid-container',
        env: { VALID_KEY: 'before\0after' },
      },
      /env values must not contain NUL bytes/i,
    );
  });

  it('requires allow-list regular expressions to match the whole identifier', async () => {
    server = await startTestServer({
      allowDockerExec: true,
      allowedContainerPatterns: ['dev'],
    });
    const client = await server.connect();
    const requestId = 'full-container-match';
    const from = client.mark();

    client.send({
      type: 'spawn',
      requestId,
      options: { container: 'dev-extra' },
    });

    const error = await expectProtocolError(client, from);
    expect(error).toMatchObject({ requestId });
    expect(error.error).toMatch(/Container access not allowed/i);
    expect(server.terminal.getStats().sessionCount).toBe(0);
  });

  it('throws during construction for an invalid administrator regex', () => {
    expect(
      () =>
        new TerminalServer({
          allowedContainerPatterns: ['[unterminated'],
        }),
    ).toThrow(/Invalid allowedContainerPatterns\[0\]/);
  });
});
