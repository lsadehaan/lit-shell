/**
 * Shared styles for lit-shell UI components
 */

import { css } from 'lit';

/**
 * Theme styles - sets CSS custom properties based on theme attribute
 */
export const themeStyles = css`
  /* Light theme */
  :host([theme='light']) {
    --ls-bg: #ffffff;
    --ls-bg-header: #f5f5f5;
    --ls-text: #1f2937;
    --ls-text-muted: #6b7280;
    --ls-border: #e5e7eb;
    --ls-terminal-bg: #ffffff;
    --ls-terminal-fg: #1f2937;
    --ls-terminal-cursor: #1f2937;
    --ls-terminal-selection: #b4d5fe;
    --ls-btn-bg: #e5e7eb;
    --ls-btn-text: #374151;
    --ls-btn-hover: #d1d5db;
    --ls-status-connected: #22c55e;
    --ls-status-disconnected: #ef4444;
  }

  /* Dark theme (default) */
  :host,
  :host([theme='dark']) {
    --ls-bg: #1e1e1e;
    --ls-bg-header: #2d2d2d;
    --ls-text: #cccccc;
    --ls-text-muted: #808080;
    --ls-border: #3e3e3e;
    --ls-terminal-bg: #1e1e1e;
    --ls-terminal-fg: #cccccc;
    --ls-terminal-cursor: #ffffff;
    --ls-terminal-selection: #264f78;
    --ls-btn-bg: #3c3c3c;
    --ls-btn-text: #cccccc;
    --ls-btn-hover: #4a4a4a;
    --ls-status-connected: #22c55e;
    --ls-status-disconnected: #ef4444;
  }

  /* Auto theme - follows system preference */
  :host([theme='auto']) {
    --ls-bg: #1e1e1e;
    --ls-bg-header: #2d2d2d;
    --ls-text: #cccccc;
    --ls-text-muted: #808080;
    --ls-border: #3e3e3e;
    --ls-terminal-bg: #1e1e1e;
    --ls-terminal-fg: #cccccc;
    --ls-terminal-cursor: #ffffff;
    --ls-terminal-selection: #264f78;
    --ls-btn-bg: #3c3c3c;
    --ls-btn-text: #cccccc;
    --ls-btn-hover: #4a4a4a;
    --ls-status-connected: #22c55e;
    --ls-status-disconnected: #ef4444;
  }

  @media (prefers-color-scheme: light) {
    :host([theme='auto']) {
      --ls-bg: #ffffff;
      --ls-bg-header: #f5f5f5;
      --ls-text: #1f2937;
      --ls-text-muted: #6b7280;
      --ls-border: #e5e7eb;
      --ls-terminal-bg: #ffffff;
      --ls-terminal-fg: #1f2937;
      --ls-terminal-cursor: #1f2937;
      --ls-terminal-selection: #b4d5fe;
      --ls-btn-bg: #e5e7eb;
      --ls-btn-text: #374151;
      --ls-btn-hover: #d1d5db;
    }
  }
`;

/**
 * Shared base styles
 */
export const sharedStyles = css`
  :host {
    display: block;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
      Ubuntu, Cantarell, sans-serif;
    font-size: 14px;
    color: var(--ls-text);
    background: var(--ls-bg);
  }

  * {
    box-sizing: border-box;
  }
`;

/**
 * Button styles
 */
export const buttonStyles = css`
  button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    border: none;
    border-radius: 4px;
    background: var(--ls-btn-bg);
    color: var(--ls-btn-text);
    font-size: 13px;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  button:hover {
    background: var(--ls-btn-hover);
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;
