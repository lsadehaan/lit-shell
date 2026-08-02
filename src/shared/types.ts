/**
 * Shared types for lit-shell.js
 */

/**
 * Session type for multiplexing
 */
export type SessionType = 'local' | 'docker-exec' | 'docker-attach';

/**
 * Terminal spawn options
 */
export interface TerminalOptions {
  /** Shell for a local session (use containerShell for Docker exec) */
  shell?: string;
  /** Working directory for a local session (use containerCwd for Docker exec) */
  cwd?: string;
  /** Environment variables for local or Docker exec sessions (not attach) */
  env?: Record<string, string>;
  /** Initial columns (default: 80, maximum: 1000) */
  cols?: number;
  /** Initial rows (default: 24, maximum: 1000) */
  rows?: number;

  // Docker container support
  /** Docker container ID or name to exec into */
  container?: string;
  /** Shell to use for Docker exec (default: /bin/bash) */
  containerShell?: string;
  /** User for Docker exec */
  containerUser?: string;
  /** Working directory for Docker exec */
  containerCwd?: string;

  // Session multiplexing options
  /** Use docker attach instead of docker exec (connects to main process) */
  attachMode?: boolean;
  /** Session label for easier identification */
  label?: string;
  /** Allow other clients to discover and join this session (default: false) */
  allowJoin?: boolean;
  /** Enable history buffer for replay on join (default: true) */
  enableHistory?: boolean;

  // Persistence options
  /** Orphan timeout in ms (0 = server default, maximum: 2147483647) */
  orphanTimeout?: number;
  /** Use tmux for a persistent Docker exec session (Docker exec only) */
  useTmux?: boolean;
  /** tmux session name (Docker exec with useTmux only; default: generated) */
  tmuxSession?: string;
}

/**
 * Server configuration
 */
export interface ServerConfig {
  /** Allowed shells (empty = all allowed) */
  allowedShells?: string[];
  /** Allowed initial local working directories (empty = all allowed; not a filesystem sandbox) */
  allowedPaths?: string[];
  /** Default shell if not specified by client */
  defaultShell?: string;
  /** Default working directory */
  defaultCwd?: string;
  /** Maximum concurrent sessions per client (minimum: 1) */
  maxSessionsPerClient?: number;
  /** Session idle timeout in ms (0 = no timeout) */
  idleTimeout?: number;
  /** Allow local host PTY sessions (default: true; disable when exposing a Docker socket) */
  allowLocalExec?: boolean;

  // Docker container support
  /** Enable Docker exec feature (default: false) */
  allowDockerExec?: boolean;
  /** Regex patterns for allowed container names/IDs (empty = all allowed when Docker exec is enabled) */
  allowedContainerPatterns?: string[];
  /** Default shell to use inside containers */
  defaultContainerShell?: string;
}

/**
 * WebSocket message types
 */
export type MessageType =
  | 'spawn'
  | 'data'
  | 'resize'
  | 'close'
  | 'error'
  | 'exit'
  | 'spawned'
  | 'listContainers'
  | 'containerList'
  | 'serverInfo'
  // Session multiplexing
  | 'listSessions'
  | 'sessionList'
  | 'join'
  | 'joined'
  | 'leave'
  | 'left'
  | 'clientJoined'
  | 'clientLeft'
  | 'sessionClosed';

/**
 * Docker container info
 */
export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: 'running' | 'paused' | 'exited' | 'unknown';
}

/**
 * Server capabilities info
 */
export interface ServerInfo {
  /** Whether the server accepts new local host PTY sessions */
  localEnabled: boolean;
  /** Whether the server accepts Docker exec/attach sessions */
  dockerEnabled: boolean;
  allowedShells: string[];
  defaultShell: string;
  defaultContainerShell?: string;
}

/**
 * Base message structure
 */
export interface BaseMessage {
  type: MessageType;
  /** Correlates a response or error with the request that caused it. */
  requestId?: string;
  sessionId?: string;
}

/**
 * Spawn request from client
 */
export interface SpawnMessage extends BaseMessage {
  type: 'spawn';
  options?: TerminalOptions;
}

/**
 * Spawned response from server
 */
export interface SpawnedMessage extends BaseMessage {
  type: 'spawned';
  sessionId: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Container ID if this is a Docker exec session */
  container?: string;
  /** Opaque owner capability for resuming this session after reconnecting. */
  resumeToken?: string;
}

/**
 * Data message (bidirectional)
 */
export interface DataMessage extends BaseMessage {
  type: 'data';
  sessionId: string;
  data: string;
}

/**
 * Resize request from client
 */
export interface ResizeMessage extends BaseMessage {
  type: 'resize';
  sessionId: string;
  cols: number;
  rows: number;
}

/**
 * Close request from client
 */
export interface CloseMessage extends BaseMessage {
  type: 'close';
  sessionId: string;
}

/**
 * Error message from server
 */
export interface ErrorMessage extends BaseMessage {
  type: 'error';
  sessionId?: string;
  error: string;
}

/**
 * Exit message from server
 */
export interface ExitMessage extends BaseMessage {
  type: 'exit';
  sessionId: string;
  exitCode: number;
}

/**
 * List containers request from client
 */
export interface ListContainersMessage extends BaseMessage {
  type: 'listContainers';
}

/**
 * Container list response from server
 */
export interface ContainerListMessage extends BaseMessage {
  type: 'containerList';
  containers: ContainerInfo[];
}

/**
 * Server info response (sent on connect)
 */
export interface ServerInfoMessage extends BaseMessage {
  type: 'serverInfo';
  info: ServerInfo;
}

/**
 * Union of all message types
 */
export type TerminalMessage =
  | SpawnMessage
  | SpawnedMessage
  | DataMessage
  | ResizeMessage
  | CloseMessage
  | ErrorMessage
  | ExitMessage
  | ListContainersMessage
  | ContainerListMessage
  | ServerInfoMessage
  // Session multiplexing
  | ListSessionsMessage
  | SessionListMessage
  | JoinMessage
  | JoinedMessage
  | LeaveMessage
  | LeftMessage
  | ClientJoinedMessage
  | ClientLeftMessage
  | SessionClosedMessage;

/**
 * Client configuration
 */
export interface ClientConfig {
  /** WebSocket URL */
  url: string;
  /** Optional WebSocket subprotocols, for example an admission capability */
  protocols?: string | string[];
  /** Reconnect on disconnect (default: true) */
  reconnect?: boolean;
  /** Maximum reconnection attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Initial reconnection delay in ms (default: 1000) */
  reconnectDelay?: number;
}

/**
 * Terminal session info
 */
export interface SessionInfo {
  sessionId: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: Date;
  /** Container ID if this is a Docker exec session */
  container?: string;
}

/**
 * Extended session info with multiplexing data
 */
export interface SharedSessionInfo extends SessionInfo {
  /** Type of session */
  type: SessionType;
  /** Number of connected clients */
  clientCount: number;
  /** Whether session accepts new clients */
  accepting: boolean;
  /** Session owner client ID */
  ownerId?: string;
  /** Session label */
  label?: string;
  /** Whether history replay is available */
  historyEnabled: boolean;
}

/**
 * Session list filter options
 */
export interface SessionListFilter {
  /** Filter by session type */
  type?: SessionType;
  /** Filter by container name/ID */
  container?: string;
  /** Show only sessions accepting new clients */
  accepting?: boolean;
}

/**
 * Join session options
 */
export interface JoinSessionOptions {
  /** Session ID to join */
  sessionId: string;
  /** Request recent output history */
  requestHistory?: boolean;
  /** Max history characters to retrieve (up to the server's history size) */
  historyLimit?: number;
  /** Owner capability returned by spawn; clients normally manage this. */
  resumeToken?: string;
}

// =============================================================================
// Session Multiplexing Messages
// =============================================================================

/**
 * List sessions request from client
 */
export interface ListSessionsMessage extends BaseMessage {
  type: 'listSessions';
  filter?: SessionListFilter;
}

/**
 * Session list response from server
 */
export interface SessionListMessage extends BaseMessage {
  type: 'sessionList';
  sessions: SharedSessionInfo[];
}

/**
 * Join session request from client
 */
export interface JoinMessage extends BaseMessage {
  type: 'join';
  options: JoinSessionOptions;
}

/**
 * Joined session response from server
 */
export interface JoinedMessage extends BaseMessage {
  type: 'joined';
  sessionId: string;
  session: SharedSessionInfo;
  /** Recent output history (if requested) */
  history?: string;
  /** Re-issued only when the owner resumed with its capability. */
  resumeToken?: string;
}

/**
 * Leave session request from client (without killing the session)
 */
export interface LeaveMessage extends BaseMessage {
  type: 'leave';
  sessionId: string;
}

/**
 * Left session response from server
 */
export interface LeftMessage extends BaseMessage {
  type: 'left';
  sessionId: string;
}

/**
 * Client joined notification (broadcast to other clients in session)
 */
export interface ClientJoinedMessage extends BaseMessage {
  type: 'clientJoined';
  sessionId: string;
  clientCount: number;
}

/**
 * Client left notification (broadcast to other clients in session)
 */
export interface ClientLeftMessage extends BaseMessage {
  type: 'clientLeft';
  sessionId: string;
  clientCount: number;
}

/**
 * Session closed notification
 */
export interface SessionClosedMessage extends BaseMessage {
  type: 'sessionClosed';
  sessionId: string;
  reason:
    | 'orphan_timeout'
    | 'owner_closed'
    | 'process_exit'
    | 'idle_timeout'
    | 'input_limit'
    | 'output_limit'
    | 'lifetime_timeout'
    | 'cleanup'
    | 'error';
}
