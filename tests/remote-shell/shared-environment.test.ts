import { describe, expect, it, vi } from 'vitest';

import {
  hardenSharedHostPaths,
  removeGuestIpcResources,
  resetSharedEnvironment,
  SHARED_HOST_PATHS,
  type IpcCleanupCommandOptions,
  type SharedHostPathOperations,
  type SharedHostPathStats,
} from '../../deploy/remote-shell/shared-environment.js';

interface MutableHostPathStats {
  directory: boolean;
  gid: number;
  mode: number;
  symbolicLink: boolean;
  uid: number;
}

describe('shared remote demo reset boundary', () => {
  it('rejects every workspace path except the fixed disposable path before touching it', async () => {
    await expect(
      resetSharedEnvironment({
        guestGid: 65_532,
        guestUid: 65_532,
        workspacePath: '/tmp/shared',
      }),
    ).rejects.toThrow('not the fixed container path');
  });

  it.each([
    { guestGid: 65_532, guestUid: 0 },
    { guestGid: 0, guestUid: 65_532 },
    { guestGid: 65_533, guestUid: 65_533 },
  ])(
    'rejects non-guest identity $guestUid:$guestGid before scanning processes',
    async (identity) => {
      await expect(
        resetSharedEnvironment({
          ...identity,
          workspacePath: '/workspace/shared',
        }),
      ).rejects.toThrow('not the fixed UID/GID');
    },
  );

  it('secures every runtime-mounted shared host path and verifies the result', async () => {
    const states = new Map(
      SHARED_HOST_PATHS.map((path) => [
        path,
        {
          directory: true,
          gid: 65_532,
          mode: 0o41_777,
          symbolicLink: false,
          uid: 65_532,
        },
      ]),
    );
    const chownCalls: unknown[][] = [];
    const chmodCalls: unknown[][] = [];
    const operations = fakeHostPathOperations(states, chownCalls, chmodCalls);

    await hardenSharedHostPaths(operations);

    expect(chownCalls).toEqual(SHARED_HOST_PATHS.map((path) => [path, 0, 0]));
    expect(chmodCalls).toEqual(SHARED_HOST_PATHS.map((path) => [path, 0o755]));
    for (const path of SHARED_HOST_PATHS) {
      expect(states.get(path)).toMatchObject({
        gid: 0,
        mode: 0o40_755,
        uid: 0,
      });
    }
  });

  it('fails closed before mutating a shared host path that is not a real directory', async () => {
    const states = new Map<string, MutableHostPathStats>([
      [
        '/tmp',
        {
          directory: false,
          gid: 0,
          mode: 0o120_777,
          symbolicLink: true,
          uid: 0,
        },
      ],
    ]);
    const chownCalls: unknown[][] = [];
    const chmodCalls: unknown[][] = [];

    await expect(
      hardenSharedHostPaths(
        fakeHostPathOperations(states, chownCalls, chmodCalls),
      ),
    ).rejects.toThrow('/tmp must be a real directory');
    expect(chownCalls).toEqual([]);
    expect(chmodCalls).toEqual([]);
  });

  it('fails closed when a shared host path does not retain its secure ownership and mode', async () => {
    const insecure = {
      directory: true,
      gid: 65_532,
      mode: 0o41_777,
      symbolicLink: false,
      uid: 65_532,
    };
    const operations: SharedHostPathOperations = {
      chmod: async () => undefined,
      chown: async () => undefined,
      lstat: async () => hostPathStats(insecure),
    };

    await expect(hardenSharedHostPaths(operations)).rejects.toThrow(
      '/tmp must be root-owned and unavailable for guest writes',
    );
  });

  it('cleans SysV IPC with one fixed, bounded, de-privileged command', async () => {
    let invocation:
      | {
          arguments_: readonly ['--all'];
          executable: '/usr/bin/ipcrm';
          options: IpcCleanupCommandOptions;
        }
      | undefined;

    await removeGuestIpcResources(
      65_532,
      65_532,
      async (executable, arguments_, options) => {
        invocation = { arguments_, executable, options };
      },
    );

    expect(invocation).toEqual({
      arguments_: ['--all'],
      executable: '/usr/bin/ipcrm',
      options: {
        cwd: '/',
        encoding: 'utf8',
        env: {
          LANG: 'C',
          LC_ALL: 'C',
          PATH: '/usr/bin:/bin',
        },
        gid: 65_532,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024,
        timeout: 2_000,
        uid: 65_532,
        windowsHide: true,
      },
    });
  });

  it('fails the reset boundary when fixed guest IPC cleanup fails', async () => {
    const cause = new Error('ipcrm failed');

    await expect(
      removeGuestIpcResources(65_532, 65_532, async () => {
        throw cause;
      }),
    ).rejects.toMatchObject({
      cause,
      message: 'Guest IPC resource cleanup failed',
    });
  });

  it('rejects a non-fixed IPC cleanup identity before running a command', async () => {
    const execute = vi.fn();

    await expect(
      removeGuestIpcResources(65_533, 65_532, execute),
    ).rejects.toThrow('not the fixed UID/GID');
    expect(execute).not.toHaveBeenCalled();
  });
});

function fakeHostPathOperations(
  states: Map<string, MutableHostPathStats>,
  chownCalls: unknown[][],
  chmodCalls: unknown[][],
): SharedHostPathOperations {
  return {
    async chmod(path, mode) {
      chmodCalls.push([path, mode]);
      const state = requiredState(states, path);
      state.mode = (state.mode & ~0o7777) | mode;
    },
    async chown(path, uid, gid) {
      chownCalls.push([path, uid, gid]);
      const state = requiredState(states, path);
      state.uid = uid;
      state.gid = gid;
    },
    async lstat(path) {
      return hostPathStats(requiredState(states, path));
    },
  };
}

function requiredState(
  states: Map<string, MutableHostPathStats>,
  path: string,
): MutableHostPathStats {
  const state = states.get(path);
  if (!state) throw new Error(`Unexpected path: ${path}`);
  return state;
}

function hostPathStats(state: MutableHostPathStats): SharedHostPathStats {
  return {
    gid: state.gid,
    isDirectory: () => state.directory,
    isSymbolicLink: () => state.symbolicLink,
    mode: state.mode,
    uid: state.uid,
  };
}
