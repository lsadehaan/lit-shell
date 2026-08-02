import { execFile } from 'node:child_process';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { promisify } from 'node:util';

const FIXED_WORKSPACE_PARENT = '/workspace';
const FIXED_WORKSPACE_PATH = '/workspace/shared';
const FIXED_GUEST_GID = 65_532;
const FIXED_GUEST_UID = 65_532;
const IPC_CLEANUP_MAX_BUFFER_BYTES = 16 * 1024;
const IPC_CLEANUP_TIMEOUT_MS = 2_000;
const PROCESS_CLEANUP_TIMEOUT_MS = 2_000;
const ROOT_DIRECTORY_MODE = 0o755;

export const SHARED_HOST_PATHS = Object.freeze([
  '/tmp',
  '/var/tmp',
  '/run/lock',
  '/dev/shm',
  '/dev/mqueue',
] as const);

export interface SharedHostPathStats {
  readonly gid: number;
  readonly mode: number;
  readonly uid: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface SharedHostPathOperations {
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  lstat(path: string): Promise<SharedHostPathStats>;
}

export interface IpcCleanupCommandOptions {
  readonly cwd: '/';
  readonly encoding: 'utf8';
  readonly env: Readonly<{
    LANG: 'C';
    LC_ALL: 'C';
    PATH: '/usr/bin:/bin';
  }>;
  readonly gid: number;
  readonly killSignal: 'SIGKILL';
  readonly maxBuffer: number;
  readonly timeout: number;
  readonly uid: number;
  readonly windowsHide: true;
}

export type IpcCleanupExecutor = (
  executable: '/usr/bin/ipcrm',
  arguments_: readonly ['--all'],
  options: IpcCleanupCommandOptions,
) => Promise<void>;

const execFileAsync = promisify(execFile);
const sharedHostPathOperations: SharedHostPathOperations = {
  chmod,
  chown,
  lstat,
};

export interface SharedEnvironmentOptions {
  readonly guestGid: number;
  readonly guestUid: number;
  readonly workspacePath: string;
}

export async function resetSharedEnvironment(
  options: SharedEnvironmentOptions,
): Promise<void> {
  if (options.workspacePath !== FIXED_WORKSPACE_PATH) {
    throw new Error(
      'The shared demo workspace path is not the fixed container path',
    );
  }
  if (
    options.guestUid !== FIXED_GUEST_UID ||
    options.guestGid !== FIXED_GUEST_GID
  ) {
    throw new Error('The shared demo guest identity is not the fixed UID/GID');
  }
  await assertRootOwnedWorkspaceParent();
  await hardenSharedHostPaths();
  await terminateGuestProcesses(options.guestUid);
  await removeGuestIpcResources(options.guestUid, options.guestGid);
  await rm(FIXED_WORKSPACE_PATH, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 50,
  });
  await mkdir('/workspace/shared/tmp', {
    mode: 0o700,
    recursive: true,
  });
  await writeFile(
    '/workspace/shared/README.txt',
    [
      'lit-shell.js shared remote demo',
      '',
      'Every visitor in this Render instance shares this writable directory.',
      'Other visitors can read, change, or remove anything you put here.',
      'All guest processes and files are discarded every five minutes.',
      'Do not enter passwords, private keys, personal data, or other secrets.',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  await Promise.all([
    chmod('/workspace/shared', 0o700),
    chmod('/workspace/shared/tmp', 0o700),
    chmod('/workspace/shared/README.txt', 0o600),
  ]);
  await Promise.all([
    chown('/workspace/shared', options.guestUid, options.guestGid),
    chown('/workspace/shared/tmp', options.guestUid, options.guestGid),
    chown('/workspace/shared/README.txt', options.guestUid, options.guestGid),
  ]);
}

export async function hardenSharedHostPaths(
  operations: SharedHostPathOperations = sharedHostPathOperations,
): Promise<void> {
  for (const path of SHARED_HOST_PATHS) {
    const initialStats = await operations.lstat(path);
    assertRealDirectory(path, initialStats);
    if (initialStats.uid !== 0 || initialStats.gid !== 0) {
      await operations.chown(path, 0, 0);
    }
    if ((initialStats.mode & 0o7777) !== ROOT_DIRECTORY_MODE) {
      await operations.chmod(path, ROOT_DIRECTORY_MODE);
    }

    const securedStats = await operations.lstat(path);
    assertRealDirectory(path, securedStats);
    if (
      securedStats.uid !== 0 ||
      securedStats.gid !== 0 ||
      (securedStats.mode & 0o7777) !== ROOT_DIRECTORY_MODE
    ) {
      throw new Error(
        `${path} must be root-owned and unavailable for guest writes`,
      );
    }
  }
}

export async function removeGuestIpcResources(
  uid: number,
  gid: number,
  execute: IpcCleanupExecutor = executeIpcCleanup,
): Promise<void> {
  if (uid !== FIXED_GUEST_UID || gid !== FIXED_GUEST_GID) {
    throw new Error('The shared demo guest identity is not the fixed UID/GID');
  }
  try {
    await execute('/usr/bin/ipcrm', ['--all'], {
      cwd: '/',
      encoding: 'utf8',
      env: Object.freeze({
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin',
      }),
      gid,
      killSignal: 'SIGKILL',
      maxBuffer: IPC_CLEANUP_MAX_BUFFER_BYTES,
      timeout: IPC_CLEANUP_TIMEOUT_MS,
      uid,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error('Guest IPC resource cleanup failed', { cause: error });
  }
}

function assertRealDirectory(path: string, stats: SharedHostPathStats): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${path} must be a real directory`);
  }
}

async function executeIpcCleanup(
  executable: '/usr/bin/ipcrm',
  arguments_: readonly ['--all'],
  options: IpcCleanupCommandOptions,
): Promise<void> {
  await execFileAsync(executable, [...arguments_], options);
}

async function assertRootOwnedWorkspaceParent(): Promise<void> {
  const stats = await lstat('/workspace');
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== 0 ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new Error(
      `${FIXED_WORKSPACE_PARENT} must be a real root-owned, non-writable directory`,
    );
  }
}

async function terminateGuestProcesses(uid: number): Promise<void> {
  const deadline = Date.now() + PROCESS_CLEANUP_TIMEOUT_MS;
  let signal: NodeJS.Signals = 'SIGTERM';
  do {
    const processIds = await guestProcessIds(uid);
    if (processIds.length === 0) return;
    for (const processId of processIds) signalProcess(processId, signal);
    await delay(signal === 'SIGTERM' ? 100 : 25);
    signal = 'SIGKILL';
  } while (Date.now() < deadline);

  const remaining = await guestProcessIds(uid);
  if (remaining.length > 0) {
    throw new Error('Guest processes survived the shared environment reset');
  }
}

async function guestProcessIds(uid: number): Promise<number[]> {
  const entries = await readdir('/proc', { withFileTypes: true });
  const matches: number[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) return;
      try {
        // The entry is constrained to canonical positive decimal PIDs above.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const status = await readFile(`/proc/${entry.name}/status`, 'utf8');
        const uidLine = status.match(/^Uid:\s+(?<real>[0-9]+)\s+/mu);
        const stateLine = status.match(/^State:\s+(?<state>[A-Z])(?:\s|$)/mu);
        if (
          Number(uidLine?.groups?.real) === uid &&
          stateLine?.groups?.state !== 'Z'
        ) {
          matches.push(Number(entry.name));
        }
      } catch (error) {
        if (!isMissingProcess(error)) throw error;
      }
    }),
  );
  return matches;
}

function signalProcess(processId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(processId, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

function isMissingProcess(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ESRCH')
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
