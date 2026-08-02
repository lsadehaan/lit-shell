import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import {
  closeForOutputBackpressure,
  OUTPUT_BACKPRESSURE_TERMINATE_DELAY_MS,
} from '../src/server/websocket-output.js';

function outputSocket(): {
  readyState: number;
  close: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
} {
  return {
    readyState: WebSocket.OPEN,
    close: vi.fn(),
    once: vi.fn(),
    terminate: vi.fn(),
  };
}

describe('output backpressure close policy', () => {
  afterEach(() => vi.useRealTimers());

  it('force-terminates a peer that does not complete the close handshake', () => {
    vi.useFakeTimers();
    const socket = outputSocket();

    closeForOutputBackpressure(socket as unknown as WebSocket);
    vi.advanceTimersByTime(OUTPUT_BACKPRESSURE_TERMINATE_DELAY_MS);

    expect(socket.close).toHaveBeenCalledWith(
      1013,
      'Client output buffer limit exceeded',
    );
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it('cancels forced termination after a successful close handshake', () => {
    vi.useFakeTimers();
    const socket = outputSocket();

    closeForOutputBackpressure(socket as unknown as WebSocket);
    const closeListener = socket.once.mock.calls.find(
      ([event]) => event === 'close',
    )?.[1] as (() => void) | undefined;
    expect(closeListener).toEqual(expect.any(Function));
    socket.readyState = WebSocket.CLOSED;
    closeListener?.();
    vi.advanceTimersByTime(OUTPUT_BACKPRESSURE_TERMINATE_DELAY_MS);

    expect(socket.terminate).not.toHaveBeenCalled();
  });
});
