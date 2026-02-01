/**
 * lit-shell.js client exports
 */

export { VERSION } from '../version.js';
export { TerminalClient } from './terminal-client.js';
export type { ConnectionState } from './terminal-client.js';
export type {
  ClientConfig,
  TerminalOptions,
  SessionInfo,
  SharedSessionInfo,
  SessionType,
  SessionListFilter,
  JoinSessionOptions,
} from '../shared/types.js';
