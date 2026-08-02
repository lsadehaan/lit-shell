import { WebSocket } from 'ws';

const OUTPUT_BACKPRESSURE_CLOSE_CODE = 1013;
const OUTPUT_BACKPRESSURE_CLOSE_REASON = 'Client output buffer limit exceeded';
export const OUTPUT_BACKPRESSURE_TERMINATE_DELAY_MS = 250;

export function canQueueWebSocketMessage(
  ws: Pick<WebSocket, 'bufferedAmount'>,
  messageBytes: number,
  maximumBufferedBytes: number,
): boolean {
  return ws.bufferedAmount + messageBytes <= maximumBufferedBytes;
}

export function closeForOutputBackpressure(
  ws: Pick<WebSocket, 'close' | 'once' | 'readyState' | 'terminate'>,
): void {
  const forceTerminate: { timer?: ReturnType<typeof setTimeout> } = {};
  ws.once('close', () => {
    if (forceTerminate.timer !== undefined) {
      clearTimeout(forceTerminate.timer);
    }
  });
  ws.close(OUTPUT_BACKPRESSURE_CLOSE_CODE, OUTPUT_BACKPRESSURE_CLOSE_REASON);
  if (ws.readyState === WebSocket.CLOSED) return;
  forceTerminate.timer = setTimeout(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }, OUTPUT_BACKPRESSURE_TERMINATE_DELAY_MS);
  forceTerminate.timer.unref();
}
