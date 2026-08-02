/**
 * lit-shell-terminal web component
 *
 * A ready-to-use terminal component that wraps xterm.js and
 * connects to an lit-shell server via WebSocket.
 *
 * Usage:
 * ```html
 * <lit-shell-terminal
 *   url="ws://localhost:3000/terminal"
 *   shell="/bin/bash"
 *   cwd="/home/user"
 *   theme="dark"
 * ></lit-shell-terminal>
 * ```
 */

import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import {
  LitElement,
  html,
  css,
  nothing,
  unsafeCSS,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { sharedStyles, buttonStyles, themeStyles } from './styles.js';
import { TerminalClient } from '../client/terminal-client.js';
import { VERSION } from '../version.js';
import { xtermStyles } from './xterm-styles.generated.js';
import type {
  TerminalOptions,
  SessionInfo,
  ContainerInfo,
  ServerInfo,
  SharedSessionInfo,
} from '../shared/types.js';

// Tab interface for multi-tab support
interface Tab {
  id: string;
  label: string;
  client: TerminalClient | null;
  terminal: Terminal | null;
  fitAddon: FitAddon | null;
  connected: boolean;
  sessionActive: boolean;
  sessionInfo: SessionInfo | null;
  clientCount: number;
  containerEl: HTMLElement | null;
}

function firstNonEmptyString(
  preferred: string | undefined,
  fallback: string | undefined,
): string | undefined {
  return preferred || fallback || undefined;
}

@customElement('lit-shell-terminal')
export class LitShellTerminal extends LitElement {
  /** lit-shell.js version */
  static readonly VERSION = VERSION;

  static override styles = [
    unsafeCSS(xtermStyles),
    sharedStyles,
    themeStyles,
    buttonStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 200px;
        border: 1px solid var(--ls-border);
        border-radius: 4px;
        overflow: hidden;
      }

      .shell {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        min-height: inherit;
        overflow: hidden;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: var(--ls-bg-header);
        border-bottom: 1px solid var(--ls-border);
      }

      .header-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
      }

      .header-actions {
        display: flex;
        gap: 8px;
      }

      .status {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--ls-text-muted);
      }

      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--ls-status-disconnected);
      }

      .status-dot.connected {
        background: var(--ls-status-connected);
      }

      .terminal-container {
        flex: 1;
        position: relative;
        background: var(--ls-terminal-bg);
        overflow: hidden;
      }

      .terminal-container .xterm {
        height: 100%;
      }

      .terminal-container .xterm-viewport {
        overflow-y: auto;
      }

      .loading,
      .error {
        position: absolute;
        inset: 0;
        z-index: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        padding: 20px;
        text-align: center;
        color: var(--ls-text-muted);
      }

      .error {
        color: #ef4444;
      }

      .loading-spinner {
        animation: spin 1s linear infinite;
        margin-right: 8px;
      }

      @keyframes spin {
        from {
          transform: rotate(0deg);
        }
        to {
          transform: rotate(360deg);
        }
      }

      /* Hide header if requested */
      :host([no-header]) .header {
        display: none;
      }

      /* Connection panel */
      .connection-panel {
        padding: 12px;
        background: var(--ls-bg-header);
        border-bottom: 1px solid var(--ls-border);
      }

      .connection-panel-title {
        font-weight: 600;
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .connection-form {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 10px;
        align-items: end;
      }

      .form-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .form-group label {
        font-size: 11px;
        text-transform: uppercase;
        color: var(--ls-text-muted);
        letter-spacing: 0.5px;
      }

      .form-group select,
      .form-group input {
        padding: 6px 10px;
        border: 1px solid var(--ls-border);
        border-radius: 4px;
        background: var(--ls-bg);
        color: var(--ls-text);
        font-size: 13px;
      }

      .form-group select:focus,
      .form-group input:focus {
        outline: none;
        border-color: var(--ls-status-connected);
      }

      /* Settings dropdown */
      .settings-dropdown {
        position: relative;
      }

      .settings-menu {
        position: absolute;
        top: 100%;
        right: 0;
        margin-top: 4px;
        min-width: 180px;
        background: var(--ls-bg-header);
        border: 1px solid var(--ls-border);
        border-radius: 4px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        z-index: 100;
        padding: 8px 0;
      }

      .settings-menu-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        font-size: 13px;
        cursor: pointer;
      }

      .settings-menu-item:hover {
        background: var(--ls-btn-hover);
      }

      .settings-menu-item select {
        padding: 4px 8px;
        border: 1px solid var(--ls-border);
        border-radius: 3px;
        background: var(--ls-bg);
        color: var(--ls-text);
        font-size: 12px;
      }

      .settings-divider {
        height: 1px;
        background: var(--ls-border);
        margin: 4px 0;
      }

      /* Status bar */
      .status-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 12px;
        background: var(--ls-bg-header);
        border-top: 1px solid var(--ls-border);
        font-size: 12px;
        color: var(--ls-text-muted);
      }

      .status-bar-left {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .status-bar-right {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .status-bar-error {
        color: #ef4444;
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .status-bar-success {
        color: var(--ls-status-connected);
      }

      /* Tab bar styles */
      .tab-bar {
        display: flex;
        align-items: center;
        background: var(--ls-bg-header);
        border-bottom: 1px solid var(--ls-border);
        padding: 0 4px;
        gap: 2px;
        min-height: 32px;
        overflow-x: auto;
      }

      .tab-list {
        display: flex;
        align-items: center;
        gap: 2px;
      }

      .tab-bar::-webkit-scrollbar {
        height: 4px;
      }

      .tab-bar::-webkit-scrollbar-thumb {
        background: var(--ls-border);
        border-radius: 2px;
      }

      .tab {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: transparent;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--ls-text-muted);
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.15s ease;
      }

      .tab:hover {
        background: var(--ls-btn-hover);
        color: var(--ls-text);
      }

      .tab.active {
        color: var(--ls-text);
        border-bottom-color: var(--ls-status-connected);
        background: var(--ls-bg);
      }

      .tab-status {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--ls-status-disconnected);
      }

      .tab-status.connected {
        background: var(--ls-status-connected);
      }

      .tab-close {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 3px;
        background: none;
        border: none;
        color: var(--ls-text-muted);
        font-size: 14px;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.15s ease;
      }

      .tab-bar:hover .tab-close,
      .tab-close:focus-visible {
        opacity: 1;
      }

      .tab-close:hover {
        background: var(--ls-btn-hover);
        color: var(--ls-text);
      }

      .tab-add {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 4px;
        background: none;
        border: none;
        color: var(--ls-text-muted);
        font-size: 18px;
        cursor: pointer;
        margin-left: 4px;
      }

      .tab-add:hover {
        background: var(--ls-btn-hover);
        color: var(--ls-text);
      }

      /* Multi-terminal container */
      .terminals-wrapper {
        flex: 1;
        position: relative;
        overflow: hidden;
      }

      .tab-terminal-container {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: var(--ls-terminal-bg);
        display: none;
      }

      .tab-terminal-container.active {
        display: block;
      }

      .tab-terminal-container .xterm {
        height: 100%;
      }

      .xterm-mount {
        position: absolute;
        inset: 4px;
      }

      /* Reconnect dialog */
      .reconnect-dialog-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }

      .reconnect-dialog {
        background: var(--ls-bg-header);
        border: 1px solid var(--ls-border);
        border-radius: 8px;
        padding: 24px;
        max-width: 320px;
        text-align: center;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      }

      .reconnect-dialog h3 {
        margin: 0 0 12px 0;
        font-size: 16px;
        color: var(--ls-text);
      }

      .reconnect-dialog p {
        margin: 0 0 20px 0;
        font-size: 14px;
        color: var(--ls-text-muted);
      }

      .reconnect-dialog-buttons {
        display: flex;
        gap: 12px;
        justify-content: center;
      }

      .reconnect-dialog-buttons button {
        padding: 8px 20px;
        border-radius: 4px;
        font-size: 14px;
        cursor: pointer;
        transition: background 0.15s ease;
      }

      .reconnect-dialog-buttons .btn-primary {
        background: var(--ls-status-connected);
        color: white;
        border: none;
      }

      .reconnect-dialog-buttons .btn-primary:hover {
        background: #1da34d;
      }

      .reconnect-dialog-buttons .btn-secondary {
        background: transparent;
        color: var(--ls-text-muted);
        border: 1px solid var(--ls-border);
      }

      .reconnect-dialog-buttons .btn-secondary:hover {
        background: var(--ls-btn-hover);
        color: var(--ls-text);
      }

      /* Touch keyboard for mobile */
      .touch-keyboard {
        display: flex;
        flex-direction: column;
        background: var(--ls-bg-header);
        border-top: 1px solid var(--ls-border);
        padding: 4px;
        gap: 4px;
      }

      .touch-keyboard-row {
        display: flex;
        gap: 4px;
        justify-content: center;
      }

      .touch-key {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 40px;
        height: 36px;
        padding: 0 8px;
        background: var(--ls-bg);
        border: 1px solid var(--ls-border);
        border-radius: 4px;
        color: var(--ls-text);
        font-size: 12px;
        font-family: inherit;
        cursor: pointer;
        touch-action: manipulation;
        user-select: none;
        -webkit-user-select: none;
        transition: background 0.1s ease;
      }

      .touch-key:active {
        background: var(--ls-btn-hover);
      }

      .touch-key.wide {
        min-width: 50px;
      }

      .touch-key.danger {
        color: #ef4444;
        border-color: #ef4444;
      }

      .touch-key.toggle-btn {
        background: var(--ls-bg-header);
        min-width: 30px;
        font-size: 14px;
      }

      .touch-key.toggle-btn.active {
        background: var(--ls-status-connected);
        color: white;
        border-color: var(--ls-status-connected);
      }

      .touch-keyboard-toggle {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2px;
        background: var(--ls-bg-header);
        border-top: 1px solid var(--ls-border);
      }

      .touch-keyboard-toggle button {
        background: none;
        border: none;
        color: var(--ls-text-muted);
        font-size: 18px;
        padding: 4px 12px;
        cursor: pointer;
      }

      .touch-keyboard-toggle button:active {
        color: var(--ls-text);
      }

      /* Extra key rows (collapsible) */
      .touch-keyboard-extra {
        overflow: hidden;
        max-height: 0;
        opacity: 0;
        transition:
          max-height 0.2s ease,
          opacity 0.2s ease;
      }

      .touch-keyboard-extra.expanded {
        max-height: 100px;
        opacity: 1;
      }

      /* Hide touch keyboard on desktop */
      :host(:not([mobile])) .touch-keyboard,
      :host(:not([mobile])) .touch-keyboard-toggle {
        display: none;
      }
    `,
  ];

  // Connection properties
  @property({ type: String }) url = '';
  @property({ type: String }) shell = '';
  @property({ type: String }) cwd = '';
  @property({ type: Number }) cols = 80;
  @property({ type: Number }) rows = 24;
  @property({ type: String, reflect: true }) theme: 'dark' | 'light' | 'auto' =
    'dark';
  @property({ type: Boolean, attribute: 'no-header' }) noHeader = false;
  @property({ type: Boolean, attribute: 'auto-connect' }) autoConnect = false;
  @property({ type: Boolean, attribute: 'auto-spawn' }) autoSpawn = false;
  @property({ type: Boolean, attribute: 'allow-join' }) allowJoin = false;

  // Docker container properties
  @property({ type: String }) container = '';
  @property({ type: String, attribute: 'container-shell' }) containerShell = '';
  @property({ type: String, attribute: 'container-user' }) containerUser = '';
  @property({ type: String, attribute: 'container-cwd' }) containerCwd = '';

  // UI panel options
  @property({ type: Boolean, attribute: 'show-connection-panel' })
  showConnectionPanel = false;
  @property({ type: Boolean, attribute: 'show-settings' }) showSettings = false;
  @property({ type: Boolean, attribute: 'show-status-bar' }) showStatusBar =
    false;
  @property({ type: Boolean, attribute: 'show-tabs' }) showTabs = false;

  // Terminal appearance
  @property({ type: Number, attribute: 'font-size' }) fontSize = 14;
  @property({ type: String, attribute: 'font-family' }) fontFamily =
    '"Cascadia Mono", "Cascadia Code", Consolas, "Ubuntu Mono", "DejaVu Sans Mono", "Liberation Mono", Hack, "Fira Code", "JetBrains Mono", Menlo, Monaco, "Courier New", monospace';

  // State
  @state() private client: TerminalClient | null = null;
  @state() private terminal: Terminal | null = null;
  @state() private fitAddon: FitAddon | null = null;
  @state() private connected = false;
  @state() private sessionActive = false;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private sessionInfo: SessionInfo | null = null;

  // Connection panel state
  @state() private containers: ContainerInfo[] = [];
  @state() private serverInfo: ServerInfo | null = null;
  @state() private selectedContainer = '';
  @state() private selectedShell = '/bin/sh';
  @state() private connectionMode:
    'local' | 'docker' | 'docker-attach' | 'join' = 'local';

  // Persistence options
  @state() private orphanTimeout = 3600000; // 1 hour default
  @state() private useTmux = false;

  // Session multiplexing state
  @state() private availableSessions: SharedSessionInfo[] = [];
  @state() private selectedSessionId = '';
  @state() private clientCount = 1;

  // Settings state
  @state() private settingsMenuOpen = false;

  // Reconnect dialog state
  @state() private showReconnectDialog = false;
  @state() private reconnectSessionId: string | null = null;

  // Mobile support state
  @state() private isMobile = false;
  @state() private showTouchKeyboard = true;
  @state() private showExtraKeyRows = false;

  // Status bar state
  @state() private statusMessage = '';
  @state() private statusType: 'info' | 'error' | 'success' = 'info';

  // Tab state
  @state() private tabs: Tab[] = [];
  @state() private activeTabId = '';
  private tabCounter = 0;

  private resizeObserver: ResizeObserver | null = null;
  private mobileMediaQuery: MediaQueryList | null = null;
  private readonly mobileMediaQueryHandler = (
    event: MediaQueryListEvent,
  ): void => {
    if (navigator.maxTouchPoints > 0) {
      this.isMobile = event.matches;
      this.updateMobileAttribute();
    }
  };

  override connectedCallback() {
    super.connectedCallback();

    // Set version as data attribute for easy inspection
    this.setAttribute('data-version', VERSION);

    // Detect mobile devices
    this.detectMobile();

    // Create initial tab if tabs are enabled
    if (this.showTabs && this.tabs.length === 0) {
      this.createTab();
    }

    if (this.autoConnect && this.url) {
      void this.connect().catch(() => {
        // connect() exposes failure through component state for declarative use.
      });
    }
  }

  /**
   * Detect if running on a mobile device
   */
  private detectMobile(): void {
    // Check for touch capability
    const hasTouch = navigator.maxTouchPoints > 0;

    // Check for mobile-sized viewport
    this.mobileMediaQuery?.removeEventListener(
      'change',
      this.mobileMediaQueryHandler,
    );
    this.mobileMediaQuery = window.matchMedia('(max-width: 768px)');
    const isMobileWidth = this.mobileMediaQuery.matches;

    // Check for mobile user agent (backup detection)
    const mobileUA =
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent,
      );

    this.isMobile = hasTouch && (isMobileWidth || mobileUA);
    this.updateMobileAttribute();

    // Listen for viewport changes
    this.mobileMediaQuery.addEventListener(
      'change',
      this.mobileMediaQueryHandler,
    );
  }

  /**
   * Update mobile attribute for CSS targeting
   */
  private updateMobileAttribute(): void {
    if (this.isMobile) {
      this.setAttribute('mobile', '');
    } else {
      this.removeAttribute('mobile');
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.cleanup();
  }

  /**
   * Connect to the terminal server
   */
  async connect(): Promise<void> {
    if (!this.url) {
      this.error = 'No URL specified';
      throw new Error(this.error);
    }

    if (this.client && this.client.getState() !== 'disconnected') {
      await this.client.connect();
      return;
    }

    this.loading = true;
    this.error = null;

    try {
      const targetTab = this.showTabs ? this.getActiveTab() : undefined;
      const client = new TerminalClient({ url: this.url });
      let autoSpawnAttempted = false;
      this.client = client;
      if (targetTab) {
        targetTab.client = client;
        this.tabs = [...this.tabs];
      }

      client.onConnect(() => {
        const previousSessionId = client.getPreviousSessionId();
        if (previousSessionId) {
          void this.recoverSession(client, targetTab, previousSessionId);
          return;
        }

        if (targetTab) targetTab.connected = true;
        if (!targetTab || targetTab.id === this.activeTabId)
          this.connected = true;
        this.dispatchEvent(
          new CustomEvent('connect', { bubbles: true, composed: true }),
        );

        if (this.autoSpawn && !autoSpawnAttempted) {
          autoSpawnAttempted = true;
          void this.spawn().catch(() => {
            // Public error state and the `error` event are updated by spawn().
          });
        }
      });

      client.onDisconnect(() => {
        if (targetTab) {
          targetTab.connected = false;
          targetTab.sessionActive = false;
          this.tabs = [...this.tabs];
        }
        if (!targetTab || targetTab.id === this.activeTabId) {
          this.connected = false;
          this.sessionActive = false;
        }
        this.dispatchEvent(
          new CustomEvent('disconnect', { bubbles: true, composed: true }),
        );
      });

      client.onError((err) => {
        this.error = err.message;
        this.setStatus(err.message, 'error');
        this.dispatchEvent(
          new CustomEvent('error', {
            detail: { error: err },
            bubbles: true,
            composed: true,
          }),
        );
      });

      client.onData((data) => {
        // Find the terminal that belongs to this client (for multi-tab support)
        if (this.showTabs) {
          const tab = this.tabs.find((t) => t.client === client);
          if (tab?.terminal) {
            tab.terminal.write(data);
          }
        } else if (this.terminal) {
          this.terminal.write(data);
        }
      });

      client.onExit((code) => {
        // Find the tab that belongs to this client
        if (this.showTabs) {
          const tab = this.tabs.find((t) => t.client === client);
          if (tab) {
            tab.sessionActive = false;
            tab.sessionInfo = null;
            if (tab.terminal) {
              tab.terminal.writeln('');
              tab.terminal.writeln(
                `\x1b[1;33m[Process exited with code: ${code}]\x1b[0m`,
              );
            }
            // Update component state if this is the active tab
            if (tab.id === this.activeTabId) {
              this.sessionActive = false;
              this.sessionInfo = null;
            }
            this.tabs = [...this.tabs]; // Trigger re-render
          }
        } else {
          this.sessionActive = false;
          this.sessionInfo = null;
          if (this.terminal) {
            this.terminal.writeln('');
            this.terminal.writeln(
              `\x1b[1;33m[Process exited with code: ${code}]\x1b[0m`,
            );
          }
        }
        this.dispatchEvent(
          new CustomEvent('exit', {
            detail: { exitCode: code },
            bubbles: true,
            composed: true,
          }),
        );
      });

      client.onSpawned((info) => {
        // Update tab-specific state
        if (this.showTabs) {
          const tab = this.tabs.find((t) => t.client === client);
          if (tab) {
            tab.sessionInfo = info;
            tab.sessionActive = true;
            // Update label to show shell/container
            tab.label =
              info.container || info.shell.split('/').pop() || 'Terminal';
            this.tabs = [...this.tabs];
          }
        }
        if (!targetTab || targetTab.id === this.activeTabId) {
          this.sessionInfo = info;
          this.sessionActive = true;
        }
        this.setStatus(
          `Session started: ${info.container || info.shell}`,
          'success',
        );
        this.dispatchEvent(
          new CustomEvent('spawned', {
            detail: { session: info },
            bubbles: true,
            composed: true,
          }),
        );
      });

      // Server info and container list handlers
      client.onServerInfo((info) => {
        this.serverInfo = info;
        if (info.dockerEnabled) {
          this.connectionMode = 'docker';
          client.requestContainerList();
        } else if (!info.localEnabled) {
          this.connectionMode = 'join';
        }
        this.selectedShell = info.dockerEnabled
          ? (info.defaultContainerShell ?? '/bin/sh')
          : info.defaultShell;
      });

      client.onContainerList((containers) => {
        this.containers = containers;
        if (containers.length > 0 && !this.selectedContainer) {
          this.selectedContainer = containers[0]?.name ?? '';
        }
      });

      // Multiplexing event handlers
      client.onSessionList((sessions) => {
        this.availableSessions = sessions;
        if (sessions.length > 0 && !this.selectedSessionId) {
          this.selectedSessionId = sessions[0]?.sessionId ?? '';
        }
      });

      client.onJoined((session, history) => {
        const tab =
          targetTab ??
          this.tabs.find((candidate) => candidate.client === client);
        if (history) (tab ? tab.terminal : this.terminal)?.write(history);
        const info: SessionInfo = {
          sessionId: session.sessionId,
          shell: session.shell,
          cwd: session.cwd,
          cols: session.cols,
          rows: session.rows,
          createdAt: session.createdAt,
          container: session.container,
        };
        if (tab) {
          tab.sessionInfo = info;
          tab.sessionActive = true;
          tab.clientCount = session.clientCount;
          this.tabs = [...this.tabs];
        }
        if (!tab || tab.id === this.activeTabId) {
          this.sessionInfo = info;
          this.sessionActive = true;
          this.clientCount = session.clientCount;
        }
      });

      client.onClientJoined((_sessionId, count) => {
        // Update tab-specific state
        if (this.showTabs) {
          const tab = this.tabs.find((t) => t.client === client);
          if (tab) {
            tab.clientCount = count;
            this.tabs = [...this.tabs];
          }
        }
        if (!targetTab || targetTab.id === this.activeTabId) {
          this.clientCount = count;
        }
        this.setStatus(`Client joined (${count} total)`, 'info');
      });

      client.onClientLeft((_sessionId, count) => {
        // Update tab-specific state
        if (this.showTabs) {
          const tab = this.tabs.find((t) => t.client === client);
          if (tab) {
            tab.clientCount = count;
            this.tabs = [...this.tabs];
          }
        }
        if (!targetTab || targetTab.id === this.activeTabId) {
          this.clientCount = count;
        }
        this.setStatus(`Client left (${count} remaining)`, 'info');
      });

      client.onSessionClosed((sessionId, reason) => {
        // Update tab-specific state
        if (this.showTabs) {
          const tab = this.tabs.find(
            (t) =>
              t.client === client && t.sessionInfo?.sessionId === sessionId,
          );
          if (tab) {
            tab.sessionActive = false;
            tab.sessionInfo = null;
            this.tabs = [...this.tabs];
          }
        }
        if (this.sessionInfo?.sessionId === sessionId) {
          this.sessionActive = false;
          this.sessionInfo = null;
          this.setStatus(`Session closed: ${reason}`, 'info');
        }
        // Refresh session list
        client.requestSessionList();
      });

      await client.connect();

      // Request session list after connecting
      client.requestSessionList();

      // Sync state to active tab
      if (targetTab && targetTab.id === this.activeTabId) {
        this.syncStateToActiveTab();
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Connection failed';
      throw err;
    } finally {
      this.loading = false;
    }
  }

  private async recoverSession(
    client: TerminalClient,
    targetTab: Tab | undefined,
    sessionId: string,
  ): Promise<void> {
    try {
      await client.join({
        sessionId,
        requestHistory: true,
        historyLimit: 50_000,
      });
      client.clearPreviousSessionId();
      this.showReconnectDialog = false;
      this.reconnectSessionId = null;
      this.setStatus('Recovered previous session', 'success');
    } catch (cause) {
      client.clearPreviousSessionId();
      this.error = cause instanceof Error ? cause.message : String(cause);
      this.setStatus(`Could not recover session: ${this.error}`, 'error');
    } finally {
      if (targetTab) {
        targetTab.connected = true;
        this.tabs = [...this.tabs];
      }
      if (!targetTab || targetTab.id === this.activeTabId)
        this.connected = true;
      this.dispatchEvent(
        new CustomEvent('connect', { bubbles: true, composed: true }),
      );
    }
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.connected = false;
    this.sessionActive = false;
    this.sessionInfo = null;
    if (this.showTabs) this.syncStateToActiveTab();
  }

  /**
   * Spawn a terminal session
   */
  async spawn(options?: TerminalOptions): Promise<SessionInfo> {
    if (!this.client || !this.connected) {
      throw new Error('Not connected to server');
    }

    this.loading = true;
    this.error = null;

    try {
      // Initialize terminal UI if needed
      await this.initTerminalUI();

      const info = await this.client.spawn(this.createSpawnOptions(options));
      this.sessionActive = true;
      this.sessionInfo = info;

      // Sync state to active tab
      if (this.showTabs) {
        this.syncStateToActiveTab();
      }

      // Refresh session list so other tabs can see this session
      this.client.requestSessionList();

      // Focus terminal
      if (this.terminal) {
        this.terminal.focus();
      }

      return info;
    } catch (err) {
      this.error =
        err instanceof Error ? err.message : 'Failed to spawn session';
      throw err;
    } finally {
      this.loading = false;
    }
  }

  private createSpawnOptions(options: TerminalOptions = {}): TerminalOptions {
    const terminal = this.terminal;
    const { allowJoin = this.allowJoin } = options;
    return {
      ...options,
      cols: terminal ? terminal.cols : this.cols,
      rows: terminal ? terminal.rows : this.rows,
      shell: firstNonEmptyString(options.shell, this.shell),
      cwd: firstNonEmptyString(options.cwd, this.cwd),
      env: options.env,
      container: firstNonEmptyString(options.container, this.container),
      containerShell: firstNonEmptyString(
        options.containerShell,
        this.containerShell,
      ),
      containerUser: firstNonEmptyString(
        options.containerUser,
        this.containerUser,
      ),
      containerCwd: firstNonEmptyString(
        options.containerCwd,
        this.containerCwd,
      ),
      allowJoin,
    };
  }

  /**
   * Initialize xterm.js UI
   */
  private async initTerminalUI(): Promise<void> {
    if (this.terminal) return;

    await this.updateComplete;

    // Get the correct container (either single terminal or tab-specific)
    const container =
      this.showTabs && this.activeTabId
        ? (this.shadowRoot?.querySelector(
            `.tab-terminal-container[data-tab-id="${this.activeTabId}"] .xterm-mount`,
          ) ?? null)
        : (this.shadowRoot?.querySelector('.terminal-container .xterm-mount') ??
          null);
    if (!container) return;

    // Get theme colors
    const terminalTheme = this.getTerminalTheme();

    // Create terminal
    const term = new Terminal({
      cursorBlink: true,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      theme: terminalTheme,
      cols: this.cols,
      rows: this.rows,
    });

    // Create fit addon
    const fit = new FitAddon();

    // Store references
    this.terminal = term;
    this.fitAddon = fit;

    term.loadAddon(fit);

    // Open terminal
    term.open(container as HTMLElement);
    fit.fit();

    // Handle user input
    term.onData((data: string) => {
      if (this.client && this.sessionActive) {
        this.client.write(data);
      }
    });

    // Handle resize
    term.onResize(({ cols, rows }) => {
      if (this.client && this.sessionActive) {
        this.client.resize(cols, rows);
      }
    });

    // Setup resize observer for this container
    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
        // Fit all visible terminals
        if (this.showTabs) {
          const activeTab = this.getActiveTab();
          if (activeTab?.fitAddon) {
            activeTab.fitAddon.fit();
          }
        } else if (this.fitAddon) {
          this.fitAddon.fit();
        }
      });
    }
    this.resizeObserver.observe(container);

    // Sync to active tab if in tab mode
    if (this.showTabs) {
      this.syncStateToActiveTab();
    }
  }

  /**
   * Get terminal theme based on component theme
   */
  private getTerminalTheme(): ITheme {
    // Determine effective theme (handle 'auto' by checking system preference)
    let effectiveTheme = this.theme;
    if (this.theme === 'auto') {
      effectiveTheme = window.matchMedia('(prefers-color-scheme: light)')
        .matches
        ? 'light'
        : 'dark';
    }

    if (effectiveTheme === 'light') {
      return {
        background: '#ffffff',
        foreground: '#1f2937',
        cursor: '#1f2937',
        cursorAccent: '#ffffff',
        selectionBackground: '#b4d5fe',
        selectionForeground: '#1f2937',
      };
    }

    // Dark theme
    return {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#ffffff',
      cursorAccent: '#1e1e1e',
      selectionBackground: '#264f78',
      selectionForeground: '#ffffff',
    };
  }

  /**
   * Kill the current session
   */
  kill(): void {
    if (this.client) {
      this.client.kill();
    }
    this.sessionActive = false;
    this.sessionInfo = null;
    if (this.showTabs) this.syncStateToActiveTab();
  }

  /**
   * Clear the terminal
   */
  clear(): void {
    if (this.terminal) {
      this.terminal.clear();
    }
  }

  /**
   * Write data to the terminal (display only, not sent to server)
   */
  write(data: string): void {
    if (this.terminal) {
      this.terminal.write(data);
    }
  }

  /**
   * Write line to the terminal (display only, not sent to server)
   */
  writeln(data: string): void {
    if (this.terminal) {
      this.terminal.writeln(data);
    }
  }

  /**
   * Focus the terminal
   */
  override focus(): void {
    if (this.terminal) {
      this.terminal.focus();
    }
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.mobileMediaQuery?.removeEventListener(
      'change',
      this.mobileMediaQueryHandler,
    );
    this.mobileMediaQuery = null;

    const terminals = new Set(
      [this.terminal, ...this.tabs.map((tab) => tab.terminal)].filter(
        (terminal): terminal is Terminal => terminal !== null,
      ),
    );
    for (const terminal of terminals) terminal.dispose();

    const clients = new Set(
      [this.client, ...this.tabs.map((tab) => tab.client)].filter(
        (client): client is TerminalClient => client !== null,
      ),
    );
    for (const client of clients) client.disconnect();

    this.terminal = null;
    this.client = null;
    this.fitAddon = null;
  }

  // ==================== Tab Management Methods ====================

  /**
   * Get the active tab
   */
  private getActiveTab(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
  }

  /**
   * Create a new tab
   */
  createTab(label?: string): Tab {
    this.tabCounter++;
    const tab: Tab = {
      id: `tab-${this.tabCounter}`,
      label: label || `Terminal ${this.tabCounter}`,
      client: null,
      terminal: null,
      fitAddon: null,
      connected: false,
      sessionActive: false,
      sessionInfo: null,
      clientCount: 1,
      containerEl: null,
    };

    this.tabs = [...this.tabs, tab];

    // Switch to the new tab
    this.switchTab(tab.id);

    return tab;
  }

  /**
   * Switch to a tab
   */
  switchTab(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    this.activeTabId = tabId;

    // Sync state from tab to component (for backward compatibility with single-terminal code)
    this.client = tab.client;
    this.terminal = tab.terminal;
    this.fitAddon = tab.fitAddon;
    this.connected = tab.connected;
    this.sessionActive = tab.sessionActive;
    this.sessionInfo = tab.sessionInfo;
    this.clientCount = tab.clientCount;

    // Focus the terminal and fit it
    void this.updateComplete.then(() => {
      if (tab.terminal) {
        tab.terminal.focus();
      }
      if (tab.fitAddon) {
        tab.fitAddon.fit();
      }
    });
  }

  /**
   * Close a tab
   */
  closeTab(tabId: string): void {
    const tabIndex = this.tabs.findIndex((t) => t.id === tabId);
    if (tabIndex === -1) return;

    const tab = this.tabs[tabIndex];
    if (!tab) return;

    // Cleanup tab resources
    if (tab.terminal) {
      tab.terminal.dispose();
    }
    if (tab.client) {
      tab.client.disconnect();
    }

    // Remove tab
    this.tabs = this.tabs.filter((t) => t.id !== tabId);

    // If we closed the active tab, switch to another
    if (this.activeTabId === tabId && this.tabs.length > 0) {
      // Switch to previous tab, or first if we were first
      const newIndex = Math.max(0, tabIndex - 1);
      const nextTab = this.tabs[newIndex];
      if (nextTab) this.switchTab(nextTab.id);
    }

    // If no tabs left, clear state
    if (this.tabs.length === 0) {
      this.activeTabId = '';
      this.client = null;
      this.terminal = null;
      this.fitAddon = null;
      this.connected = false;
      this.sessionActive = false;
      this.sessionInfo = null;
    }
  }

  /**
   * Update the active tab's state from component state
   */
  private syncStateToActiveTab(): void {
    const tab = this.getActiveTab();
    if (tab) {
      tab.client = this.client;
      tab.terminal = this.terminal;
      tab.fitAddon = this.fitAddon;
      tab.connected = this.connected;
      tab.sessionActive = this.sessionActive;
      tab.sessionInfo = this.sessionInfo;
      tab.clientCount = this.clientCount;
      // Trigger re-render
      this.tabs = [...this.tabs];
    }
  }

  /**
   * Render the tab bar
   */
  private renderTabBar() {
    if (!this.showTabs) return nothing;

    return html`
      <div class="tab-bar">
        <div class="tab-list" role="tablist" aria-label="Terminal sessions">
          ${repeat(
            this.tabs,
            (tab) => tab.id,
            (tab) => html`
              <button
                class="tab ${tab.id === this.activeTabId ? 'active' : ''}"
                id="tab-${tab.id}"
                role="tab"
                aria-controls="panel-${tab.id}"
                aria-selected=${tab.id === this.activeTabId ? 'true' : 'false'}
                tabindex=${tab.id === this.activeTabId ? '0' : '-1'}
                @click=${() => this.switchTab(tab.id)}
              >
                <span
                  class="tab-status ${tab.sessionActive ? 'connected' : ''}"
                  aria-hidden="true"
                ></span>
                <span>${tab.label}</span>
              </button>
            `,
          )}
        </div>
        ${
          this.tabs.length > 1
            ? html`
                <button
                  class="tab-close"
                  aria-label="Close active terminal tab"
                  @click=${() => this.closeTab(this.activeTabId)}
                  title="Close active tab"
                >
                  ×
                </button>
              `
            : nothing
        }
        <button
          class="tab-add"
          aria-label="New terminal tab"
          @click=${() => this.createTab()}
          title="New tab"
        >
          +
        </button>
      </div>
    `;
  }

  // ==================== End Tab Management Methods ====================

  /**
   * Set status message
   */
  private setStatus(
    message: string,
    type: 'info' | 'error' | 'success' = 'info',
  ): void {
    this.statusMessage = message;
    this.statusType = type;

    // Auto-clear success/info messages after 5 seconds
    if (type !== 'error') {
      setTimeout(() => {
        if (this.statusMessage === message) {
          this.statusMessage = '';
        }
      }, 5000);
    }
  }

  /**
   * Clear status message
   */
  clearStatus(): void {
    this.statusMessage = '';
    this.statusType = 'info';
  }

  /**
   * Handle theme change
   */
  private handleThemeChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    this.theme = select.value as 'dark' | 'light' | 'auto';

    // Apply theme to xterm.js terminal
    this.applyTerminalTheme();

    this.dispatchEvent(
      new CustomEvent('theme-change', {
        detail: { theme: this.theme },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Apply current theme to xterm.js terminal
   */
  private applyTerminalTheme(): void {
    if (!this.terminal) return;

    const terminalTheme = this.getTerminalTheme();
    this.terminal.options.theme = terminalTheme;
  }

  /**
   * Apply current font size to xterm.js terminal
   */
  private applyTerminalFontSize(): void {
    if (!this.terminal) return;

    this.terminal.options.fontSize = this.fontSize;

    // Re-fit the terminal after font size change
    if (this.fitAddon) {
      this.fitAddon.fit();
    }
  }

  /**
   * Handle connection mode change
   */
  private handleModeChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    this.connectionMode = select.value as
      'local' | 'docker' | 'docker-attach' | 'join';

    if (
      (this.connectionMode === 'docker' ||
        this.connectionMode === 'docker-attach') &&
      this.client &&
      this.connected
    ) {
      this.client.requestContainerList();
    }
    if (this.connectionMode === 'join' && this.client && this.connected) {
      this.client.requestSessionList();
    }
  }

  /**
   * Refresh session list
   */
  private refreshSessions(): void {
    if (this.client && this.connected) {
      this.client.requestSessionList();
    }
  }

  /**
   * Join an existing session
   */
  async join(
    sessionId: string,
    requestHistory = true,
  ): Promise<SharedSessionInfo> {
    if (!this.client || !this.connected) {
      throw new Error('Not connected to server');
    }

    this.loading = true;
    this.error = null;

    try {
      // Initialize terminal UI if needed
      await this.initTerminalUI();

      const session = await this.client.join({
        sessionId,
        requestHistory,
        historyLimit: 50000,
      });

      this.sessionActive = true;
      this.sessionInfo = {
        sessionId: session.sessionId,
        shell: session.shell,
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        createdAt: session.createdAt,
        container: session.container,
      };
      this.clientCount = session.clientCount;

      // Sync state to active tab
      if (this.showTabs) {
        this.syncStateToActiveTab();
      }

      this.setStatus(
        `Joined session (${session.clientCount} clients)`,
        'success',
      );

      // Focus terminal
      if (this.terminal) {
        this.terminal.focus();
      }

      return session;
    } catch (err) {
      this.error =
        err instanceof Error ? err.message : 'Failed to join session';
      throw err;
    } finally {
      this.loading = false;
    }
  }

  /**
   * Leave current session without killing it
   */
  leave(): void {
    if (this.client && this.sessionInfo) {
      this.client.leave(this.sessionInfo.sessionId);
      this.sessionActive = false;
      this.sessionInfo = null;
      if (this.showTabs) this.syncStateToActiveTab();
      this.setStatus('Left session', 'info');
    }
  }

  /**
   * Handle connect from connection panel
   */
  private async handlePanelConnect(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }

    if (this.connected) {
      if (this.connectionMode === 'join' && this.selectedSessionId) {
        // Join existing session
        await this.join(this.selectedSessionId);
      } else if (
        this.connectionMode === 'docker-attach' &&
        this.selectedContainer
      ) {
        // Docker attach mode - connect to container's main process
        const options: TerminalOptions = {
          container: this.selectedContainer,
          attachMode: true,
          orphanTimeout: this.orphanTimeout,
        };
        await this.spawn(options);
      } else {
        // Spawn new session (local or docker exec)
        const options: TerminalOptions = {
          orphanTimeout: this.orphanTimeout,
        };

        if (this.connectionMode === 'docker' && this.selectedContainer) {
          options.container = this.selectedContainer;
          options.containerShell = this.selectedShell || '/bin/sh';
          options.useTmux = this.useTmux;
        } else {
          options.shell = this.selectedShell || undefined;
        }

        await this.spawn(options);
      }
    }
  }

  /**
   * Toggle settings menu
   */
  private toggleSettingsMenu(): void {
    this.settingsMenuOpen = !this.settingsMenuOpen;
  }

  /**
   * Handle reconnect dialog - Yes button
   */
  private async handleReconnectYes(): Promise<void> {
    if (!this.reconnectSessionId || !this.client) return;

    this.showReconnectDialog = false;

    try {
      // Initialize terminal UI if needed
      await this.initTerminalUI();

      // Join the previous session with history
      await this.join(this.reconnectSessionId, true);
      this.setStatus('Rejoined previous session', 'success');
    } catch (err) {
      this.setStatus(
        `Failed to rejoin: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'error',
      );
    }

    this.reconnectSessionId = null;
    this.client.clearPreviousSessionId();
  }

  /**
   * Handle reconnect dialog - No button
   */
  private handleReconnectNo(): void {
    this.showReconnectDialog = false;
    this.reconnectSessionId = null;
    this.client?.clearPreviousSessionId();
  }

  /**
   * Render reconnect dialog
   */
  private renderReconnectDialog() {
    if (!this.showReconnectDialog) return nothing;

    return html`
      <div class="reconnect-dialog-overlay">
        <div class="reconnect-dialog">
          <h3>Session Available</h3>
          <p>
            Your previous session is still active. Would you like to rejoin?
          </p>
          <div class="reconnect-dialog-buttons">
            <button class="btn-primary" @click=${this.handleReconnectYes}>
              Yes, Rejoin
            </button>
            <button class="btn-secondary" @click=${this.handleReconnectNo}>
              No, Start New
            </button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render connection panel
   */
  private renderConnectionPanel() {
    if (!this.showConnectionPanel) return nothing;

    const runningContainers = this.containers.filter(
      (container) => container.state === 'running',
    );
    const acceptingSessions = this.availableSessions.filter(
      (session) => session.accepting,
    );

    return html`
      <div class="connection-panel">
        ${this.renderConnectionTitle()}
        <div class="connection-form">
          ${this.renderConnectionMode(acceptingSessions.length)}
          ${this.renderConnectionTarget(acceptingSessions, runningContainers)}
          ${this.renderShellSelector()} ${this.renderTimeoutSelector()}
          ${this.renderTmuxSelector()} ${this.renderConnectionAction()}
        </div>
      </div>
    `;
  }

  private renderConnectionTitle() {
    return html`
      <div class="connection-panel-title">
        <span>Connection</span>
        ${
          this.availableSessions.length > 0
            ? html`<span
                style="font-size: 11px; color: var(--ls-status-connected);"
                >${this.availableSessions.length} session(s) available</span
              >`
            : nothing
        }
        ${
          this.serverInfo?.dockerEnabled
            ? html`<span style="font-size: 11px; color: var(--ls-text-muted);"
                >Docker enabled</span
              >`
            : nothing
        }
      </div>
    `;
  }

  private renderConnectionMode(acceptingSessionCount: number) {
    return html`
      <div class="form-group">
        <label for="connection-mode">Mode</label>
        <select
          id="connection-mode"
          .value=${this.connectionMode}
          @change=${this.handleModeChange}
          ?disabled=${this.sessionActive}
        >
          ${this.renderLocalModeOption()} ${this.renderDockerModeOptions()}
          ${this.renderJoinModeOption(acceptingSessionCount)}
        </select>
      </div>
    `;
  }

  private renderLocalModeOption() {
    return this.renderModeOption(
      !this.localExecutionDisabled(),
      html`<option value="local">New Local Shell</option>`,
    );
  }

  private renderDockerModeOptions() {
    return this.renderModeOption(
      this.serverInfo !== null && this.serverInfo.dockerEnabled,
      html`
        <option value="docker">Docker Exec (new shell)</option>
        <option value="docker-attach">Docker Attach (main process)</option>
      `,
    );
  }

  private renderJoinModeOption(acceptingSessionCount: number) {
    return this.renderModeOption(
      acceptingSessionCount > 0,
      html`<option value="join">Join Existing Session</option>`,
    );
  }

  private renderModeOption(visible: boolean, option: TemplateResult) {
    return visible ? option : nothing;
  }

  private localExecutionDisabled(): boolean {
    return this.serverInfo !== null && !this.serverInfo.localEnabled;
  }

  private renderConnectionTarget(
    acceptingSessions: SharedSessionInfo[],
    runningContainers: ContainerInfo[],
  ) {
    if (this.connectionMode === 'join') {
      return this.renderSessionSelector(acceptingSessions);
    }
    if (
      this.connectionMode === 'docker' ||
      this.connectionMode === 'docker-attach'
    ) {
      return this.renderContainerSelector(runningContainers);
    }
    return nothing;
  }

  private renderSessionSelector(sessions: SharedSessionInfo[]) {
    return html`
      <div class="form-group">
        <label
          for="connection-session"
          style="display: flex; justify-content: space-between; align-items: center;"
        >
          <span>Session</span>
          <button
            style="font-size: 10px; padding: 2px 6px;"
            @click=${this.refreshSessions}
            ?disabled=${!this.connected}
          >
            Refresh
          </button>
        </label>
        <select
          id="connection-session"
          .value=${this.selectedSessionId}
          @change=${this.handleSessionSelection}
          ?disabled=${this.sessionActive}
        >
          ${
            sessions.length === 0
              ? html`<option value="">No sessions available</option>`
              : sessions.map(
                  (session) => html`
                    <option value=${session.sessionId}>
                      ${session.label || session.sessionId.substring(0, 12)}
                      (${this.sessionTargetLabel(session)}) -
                      ${session.clientCount} client(s)
                    </option>
                  `,
                )
          }
        </select>
      </div>
    `;
  }

  private sessionTargetLabel(session: SharedSessionInfo): string {
    if (session.type === 'local') return session.shell;
    return session.container || session.type;
  }

  private handleSessionSelection(event: Event): void {
    this.selectedSessionId = (event.target as HTMLSelectElement).value;
  }

  private renderContainerSelector(containers: ContainerInfo[]) {
    return html`
      <div class="form-group">
        <label for="connection-container">Container</label>
        <select
          id="connection-container"
          .value=${this.selectedContainer}
          @change=${this.handleContainerSelection}
          ?disabled=${this.sessionActive}
        >
          ${
            containers.length === 0
              ? html`<option value="">No containers running</option>`
              : containers.map(
                  (container) => html`
                    <option value=${container.name}>
                      ${container.name} (${container.image})
                    </option>
                  `,
                )
          }
        </select>
      </div>
    `;
  }

  private handleContainerSelection(event: Event): void {
    this.selectedContainer = (event.target as HTMLSelectElement).value;
  }

  private renderShellSelector() {
    if (
      this.connectionMode === 'join' ||
      this.connectionMode === 'docker-attach'
    ) {
      return nothing;
    }
    const allowedShells = this.serverInfo?.allowedShells;
    return html`
      <div class="form-group">
        <label for="connection-shell">Shell</label>
        <select
          id="connection-shell"
          .value=${this.selectedShell}
          @change=${this.handleShellSelection}
          ?disabled=${this.sessionActive}
        >
          ${
            allowedShells?.length
              ? allowedShells.map(
                  (shell) => html`<option value=${shell}>${shell}</option>`,
                )
              : html`
                  <option value="/bin/bash">/bin/bash</option>
                  <option value="/bin/sh">/bin/sh</option>
                  <option value="/bin/zsh">/bin/zsh</option>
                `
          }
        </select>
      </div>
    `;
  }

  private handleShellSelection(event: Event): void {
    this.selectedShell = (event.target as HTMLSelectElement).value;
  }

  private renderTimeoutSelector() {
    if (this.connectionMode !== 'local' && this.connectionMode !== 'docker') {
      return nothing;
    }
    return html`
      <div class="form-group">
        <label for="connection-timeout">Session Timeout</label>
        <select
          id="connection-timeout"
          .value=${String(this.orphanTimeout)}
          @change=${this.handleTimeoutSelection}
          ?disabled=${this.sessionActive}
        >
          <option value="60000">1 minute</option>
          <option value="300000">5 minutes</option>
          <option value="900000">15 minutes</option>
          <option value="3600000">1 hour</option>
          <option value="21600000">6 hours</option>
          <option value="86400000">24 hours</option>
          <option value="604800000">1 week</option>
        </select>
      </div>
    `;
  }

  private handleTimeoutSelection(event: Event): void {
    this.orphanTimeout = Number.parseInt(
      (event.target as HTMLSelectElement).value,
      10,
    );
  }

  private renderTmuxSelector() {
    if (this.connectionMode !== 'docker') return nothing;
    return html`
      <div class="form-group">
        <label style="display: flex; align-items: center; gap: 6px;">
          <input
            type="checkbox"
            .checked=${this.useTmux}
            @change=${this.handleTmuxSelection}
            ?disabled=${this.sessionActive}
          />
          Use tmux (persist forever)
        </label>
      </div>
    `;
  }

  private handleTmuxSelection(event: Event): void {
    this.useTmux = (event.target as HTMLInputElement).checked;
  }

  private renderConnectionAction() {
    let label = 'Start Session';
    if (this.loading) label = 'Starting...';
    if (this.connectionMode === 'join') label = 'Join Session';
    if (this.connectionMode === 'docker-attach') label = 'Attach';

    return html`
      <div class="form-group">
        ${
          !this.connected
            ? html`<button
                class="btn-primary"
                @click=${this.handlePanelConnect}
                ?disabled=${this.loading}
              >
                ${this.loading ? 'Connecting...' : 'Connect'}
              </button>`
            : this.sessionActive
              ? html`<button
                  class="btn-danger"
                  @click=${this.clientCount > 1 ? this.leave : this.kill}
                >
                  ${this.clientCount > 1 ? 'Leave Session' : 'Stop Session'}
                </button>`
              : html`<button
                  class="btn-primary"
                  @click=${this.handlePanelConnect}
                  ?disabled=${this.connectionActionDisabled()}
                >
                  ${label}
                </button>`
        }
      </div>
    `;
  }

  private connectionActionDisabled(): boolean {
    const missingRequiredTarget: Record<typeof this.connectionMode, boolean> = {
      local: this.localExecutionDisabled(),
      join: !this.selectedSessionId,
      docker: !this.selectedContainer,
      'docker-attach': !this.selectedContainer,
    };
    return this.loading || missingRequiredTarget[this.connectionMode];
  }

  /**
   * Render settings dropdown
   */
  private renderSettingsDropdown() {
    if (!this.showSettings) return nothing;

    return html`
      <div class="settings-dropdown">
        <button
          aria-label="Settings"
          aria-expanded=${this.settingsMenuOpen ? 'true' : 'false'}
          aria-haspopup="menu"
          @click=${this.toggleSettingsMenu}
          title="Settings"
        >
          ⚙️
        </button>
        ${
          this.settingsMenuOpen
            ? html`
                <div class="settings-menu">
                  <div class="settings-menu-item">
                    <label for="terminal-theme">Theme</label>
                    <select
                      id="terminal-theme"
                      .value=${this.theme}
                      @change=${this.handleThemeChange}
                    >
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                      <option value="auto">Auto</option>
                    </select>
                  </div>
                  <div class="settings-divider"></div>
                  <div class="settings-menu-item">
                    <label for="terminal-font-size">Font Size</label>
                    <select
                      id="terminal-font-size"
                      .value=${String(this.fontSize)}
                      @change=${(e: Event) => {
                        this.fontSize = parseInt(
                          (e.target as HTMLSelectElement).value,
                        );
                        this.applyTerminalFontSize();
                      }}
                    >
                      <option value="12">12px</option>
                      <option value="14">14px</option>
                      <option value="16">16px</option>
                      <option value="18">18px</option>
                    </select>
                  </div>
                  <div class="settings-divider"></div>
                  <button class="settings-menu-item" @click=${this.clear}>
                    <span>Clear Terminal</span>
                  </button>
                </div>
              `
            : nothing
        }
      </div>
    `;
  }

  // ==================== Touch Keyboard Methods ====================

  // Modifier key state for touch keyboard
  @state() private ctrlPressed = false;
  @state() private altPressed = false;

  /**
   * Send a special key sequence to the terminal
   */
  private sendKey(key: string): void {
    if (!this.client || !this.sessionActive) return;

    // Apply modifiers if pressed
    let sequence = key;

    if (this.ctrlPressed) {
      // Convert to control character (Ctrl+A = \x01, Ctrl+C = \x03, etc.)
      if (key.length === 1 && key >= 'a' && key <= 'z') {
        sequence = String.fromCharCode(key.charCodeAt(0) - 96);
      } else if (key.length === 1 && key >= 'A' && key <= 'Z') {
        sequence = String.fromCharCode(key.charCodeAt(0) - 64);
      }
      this.ctrlPressed = false;
    }

    if (this.altPressed) {
      // Alt/Meta sends ESC prefix
      sequence = '\x1b' + sequence;
      this.altPressed = false;
    }

    this.client.write(sequence);
    this.terminal?.focus();
  }

  /**
   * Send ANSI escape sequence
   */
  private sendEscape(code: string): void {
    if (!this.client || !this.sessionActive) return;
    this.client.write('\x1b' + code);
    this.terminal?.focus();
  }

  /**
   * Send control character directly
   */
  private sendCtrl(char: string): void {
    if (!this.client || !this.sessionActive) return;
    const code = char.toUpperCase().charCodeAt(0) - 64;
    this.client.write(String.fromCharCode(code));
    this.terminal?.focus();
  }

  /**
   * Toggle Ctrl modifier
   */
  private toggleCtrl(): void {
    this.ctrlPressed = !this.ctrlPressed;
    this.altPressed = false; // Reset alt when ctrl toggled
  }

  /**
   * Toggle Alt modifier
   */
  private toggleAlt(): void {
    this.altPressed = !this.altPressed;
    this.ctrlPressed = false; // Reset ctrl when alt toggled
  }

  /**
   * Toggle extra key rows visibility
   */
  private toggleExtraRows(): void {
    this.showExtraKeyRows = !this.showExtraKeyRows;
  }

  /**
   * Toggle touch keyboard visibility
   */
  private toggleTouchKeyboard(): void {
    this.showTouchKeyboard = !this.showTouchKeyboard;
  }

  /**
   * Render touch keyboard for mobile
   */
  private renderTouchKeyboard() {
    if (!this.isMobile) return nothing;

    return html`
      <!-- Toggle bar to show/hide keyboard -->
      <div class="touch-keyboard-toggle">
        <button
          @click=${this.toggleTouchKeyboard}
          title="${this.showTouchKeyboard ? 'Hide' : 'Show'} keyboard"
        >
          ${this.showTouchKeyboard ? '▼' : '▲'}
        </button>
      </div>

      ${
        this.showTouchKeyboard
          ? html`
              <div class="touch-keyboard">
                <!-- Row 1: ESC, navigation, special -->
                <div class="touch-keyboard-row">
                  <button class="touch-key" @click=${() => this.sendEscape('')}>
                    ESC
                  </button>
                  <button class="touch-key" @click=${() => this.sendKey('/')}>
                    /
                  </button>
                  <button class="touch-key" @click=${() => this.sendKey('-')}>
                    -
                  </button>
                  <button
                    class="touch-key"
                    @click=${() => this.sendEscape('[H')}
                  >
                    HOME
                  </button>
                  <button
                    class="touch-key"
                    @click=${() => this.sendEscape('[A')}
                  >
                    ↑
                  </button>
                  <button
                    class="touch-key"
                    @click=${() => this.sendEscape('[F')}
                  >
                    END
                  </button>
                  <button
                    class="touch-key"
                    @click=${() => this.sendEscape('[5~')}
                  >
                    PGUP
                  </button>
                </div>

                <!-- Row 2: TAB, modifiers, arrows -->
                <div class="touch-keyboard-row">
                  <button class="touch-key" @click=${() => this.sendKey('\t')}>
                    TAB
                  </button>
                  <button
                    class="touch-key toggle-btn ${this.ctrlPressed ? 'active' : ''}"
                    @click=${this.toggleCtrl}
                  >
                    CTRL
                  </button>
                  <button
                    class="touch-key toggle-btn ${this.altPressed ? 'active' : ''}"
                    @click=${this.toggleAlt}
                  >
                    ALT
                  </button>
                  <button
                    class="touch-key"
                    @click=${() => this.sendEscape('[D')}
                  >
                    ←
                  </button>
                  <button
                    class="touch-key"
                    @click=${() => this.sendEscape('[B')}
                  >
                    ↓
                  </button>
                  <button
                    class="touch-key"
                    @click=${() => this.sendEscape('[C')}
                  >
                    →
                  </button>
                  <button
                    class="touch-key"
                    @click=${() => this.sendEscape('[6~')}
                  >
                    PGDN
                  </button>
                </div>

                <!-- Expandable extra rows -->
                <div
                  class="touch-keyboard-extra ${this.showExtraKeyRows ? 'expanded' : ''}"
                >
                  <!-- Row 3: Common control sequences -->
                  <div class="touch-keyboard-row">
                    <button
                      class="touch-key danger"
                      @click=${() => this.sendCtrl('C')}
                    >
                      ^C
                    </button>
                    <button
                      class="touch-key"
                      @click=${() => this.sendCtrl('D')}
                    >
                      ^D
                    </button>
                    <button
                      class="touch-key"
                      @click=${() => this.sendCtrl('Z')}
                    >
                      ^Z
                    </button>
                    <button
                      class="touch-key"
                      @click=${() => this.sendCtrl('L')}
                    >
                      ^L
                    </button>
                    <button
                      class="touch-key"
                      @click=${() => this.sendCtrl('A')}
                    >
                      ^A
                    </button>
                    <button
                      class="touch-key"
                      @click=${() => this.sendCtrl('E')}
                    >
                      ^E
                    </button>
                    <button
                      class="touch-key"
                      @click=${() => this.sendCtrl('R')}
                    >
                      ^R
                    </button>
                  </div>
                </div>

                <!-- Toggle for extra rows -->
                <div class="touch-keyboard-row">
                  <button
                    class="touch-key wide"
                    @click=${this.toggleExtraRows}
                    title="${this.showExtraKeyRows ? 'Hide' : 'Show'} extra keys"
                  >
                    ${this.showExtraKeyRows ? '▲ Less' : '▼ More'}
                  </button>
                </div>
              </div>
            `
          : nothing
      }
    `;
  }

  // ==================== End Touch Keyboard Methods ====================

  /**
   * Render status bar
   */
  private renderStatusBar() {
    if (!this.showStatusBar) return nothing;

    return html`
      <div class="status-bar">
        <div class="status-bar-left">
          <span class="status-dot ${this.connected ? 'connected' : ''}"></span>
          <span
            >${
              this.connected
                ? this.sessionActive
                  ? 'Session active'
                  : 'Connected'
                : 'Disconnected'
            }</span
          >
          ${
            this.sessionInfo
              ? html`
                  <span style="color: var(--ls-text-muted)">|</span>
                  <span
                    >${this.sessionInfo.container || this.sessionInfo.shell}</span
                  >
                  <span style="color: var(--ls-text-muted)"
                    >${this.sessionInfo.cols}x${this.sessionInfo.rows}</span
                  >
                `
              : nothing
          }
        </div>
        <div class="status-bar-right">
          ${
            this.statusMessage
              ? html`
                  <span
                    class="${this.statusType === 'error' ? 'status-bar-error' : this.statusType === 'success' ? 'status-bar-success' : ''}"
                  >
                    ${this.statusType === 'error' ? '⚠️' : this.statusType === 'success' ? '✓' : ''}
                    ${this.statusMessage}
                  </span>
                  <button
                    style="background: none; border: none; cursor: pointer; padding: 0; font-size: 10px;"
                    @click=${this.clearStatus}
                    title="Dismiss"
                  >
                    ✕
                  </button>
                `
              : nothing
          }
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="shell">
        ${
          this.noHeader
            ? nothing
            : html`
                <div class="header">
                  <div class="header-title">
                    <span>Terminal</span>
                    ${
                      this.sessionInfo
                        ? html`<span
                            style="font-weight: normal; font-size: 12px; color: var(--ls-text-muted)"
                          >
                            ${
                              this.sessionInfo.container
                                ? `${this.sessionInfo.container} (${this.sessionInfo.shell})`
                                : this.sessionInfo.shell
                            }
                          </span>`
                        : nothing
                    }
                  </div>
                  <div class="header-actions">
                    ${
                      !this.showConnectionPanel
                        ? html`
                            ${
                              !this.connected
                                ? html`<button
                                    @click=${this.connect}
                                    ?disabled=${this.loading}
                                  >
                                    ${this.loading ? 'Connecting...' : 'Connect'}
                                  </button>`
                                : !this.sessionActive
                                  ? html`<button
                                      @click=${() => this.spawn()}
                                      ?disabled=${this.loading}
                                    >
                                      ${this.loading ? 'Spawning...' : 'Start'}
                                    </button>`
                                  : html`<button @click=${this.kill}>
                                      Stop
                                    </button>`
                            }
                          `
                        : nothing
                    }
                    <button
                      @click=${this.clear}
                      ?disabled=${!this.sessionActive}
                    >
                      Clear
                    </button>
                    ${this.renderSettingsDropdown()}
                    ${
                      !this.showStatusBar
                        ? html`
                            <div class="status">
                              <span
                                class="status-dot ${this.connected ? 'connected' : ''}"
                              ></span>
                              <span
                                >${this.connected ? 'Connected' : 'Disconnected'}</span
                              >
                            </div>
                          `
                        : nothing
                    }
                  </div>
                </div>
              `
        }
        ${this.renderConnectionPanel()} ${this.renderTabBar()}
        ${
          this.showTabs && this.tabs.length > 0
            ? html`
                <div class="terminals-wrapper">
                  ${repeat(
                    this.tabs,
                    (tab) => tab.id,
                    (tab) => html`
                      <div
                        class="tab-terminal-container ${tab.id === this.activeTabId ? 'active' : ''}"
                        id="panel-${tab.id}"
                        data-tab-id=${tab.id}
                        role="tabpanel"
                        aria-labelledby="tab-${tab.id}"
                        ?hidden=${tab.id !== this.activeTabId}
                      >
                        <div class="xterm-mount"></div>
                        ${
                          this.loading &&
                          tab.id === this.activeTabId &&
                          !tab.terminal
                            ? html`<div class="loading">
                                <span class="loading-spinner">⏳</span>
                                Loading...
                              </div>`
                            : this.error &&
                                tab.id === this.activeTabId &&
                                !tab.terminal
                              ? html`<div class="error">❌ ${this.error}</div>`
                              : nothing
                        }
                      </div>
                    `,
                  )}
                </div>
              `
            : html`
                <div class="terminal-container">
                  <div class="xterm-mount"></div>
                  ${
                    this.loading && !this.terminal
                      ? html`<div class="loading">
                          <span class="loading-spinner">⏳</span> Loading...
                        </div>`
                      : this.error && !this.terminal
                        ? html`<div class="error">❌ ${this.error}</div>`
                        : nothing
                  }
                </div>
              `
        }
        ${this.renderStatusBar()} ${this.renderTouchKeyboard()}
        ${this.renderReconnectDialog()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lit-shell-terminal': LitShellTerminal;
  }
}
