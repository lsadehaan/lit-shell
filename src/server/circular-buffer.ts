/**
 * Circular buffer for storing terminal history.
 *
 * Efficiently stores a fixed-size rotating buffer of terminal output,
 * automatically discarding oldest content when capacity is exceeded.
 */

export class CircularBuffer {
  private buffer: string[] = [];
  private readonly maxSize: number;
  private currentSize = 0;

  /**
   * Create a new circular buffer.
   * @param maxSize Maximum size in characters
   */
  constructor(maxSize: number) {
    if (!Number.isSafeInteger(maxSize) || maxSize < 0) {
      throw new RangeError(
        'CircularBuffer capacity must be a non-negative integer',
      );
    }
    this.maxSize = maxSize;
  }

  /**
   * Append data to the buffer.
   * If the buffer exceeds capacity, oldest data is removed.
   * @param data The string data to append
   */
  append(data: string): void {
    if (!data) return;

    this.buffer.push(data);
    this.currentSize += data.length;

    // Remove exactly the overflow, including a prefix of the oldest chunk.
    // Dropping whole chunks here would retain less history than the configured
    // capacity whenever the boundary lands in the middle of a chunk.
    let overflow = this.currentSize - this.maxSize;
    while (overflow > 0) {
      const oldest = this.buffer[0];
      if (oldest === undefined) break;

      if (oldest.length <= overflow) {
        this.buffer.shift();
        this.currentSize -= oldest.length;
        overflow -= oldest.length;
      } else {
        this.buffer[0] = oldest.slice(overflow);
        this.currentSize -= overflow;
        overflow = 0;
      }
    }
  }

  /**
   * Get buffer contents as a string.
   * @param limit Optional limit on the number of characters to return (from end)
   * @returns The buffer contents
   */
  toString(limit?: number): string {
    const content = this.buffer.join('');
    if (limit !== undefined) {
      if (!Number.isFinite(limit) || limit >= content.length) return content;
      if (limit <= 0) return '';
      return content.slice(-Math.floor(limit));
    }
    return content;
  }

  /**
   * Get the last N characters from the buffer.
   * @param n Number of characters to retrieve
   * @returns The last N characters
   */
  tail(n: number): string {
    return this.toString(n);
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.buffer = [];
    this.currentSize = 0;
  }

  /**
   * Get current size of the buffer in characters.
   */
  size(): number {
    return this.currentSize;
  }

  /**
   * Get the maximum size of the buffer.
   */
  capacity(): number {
    return this.maxSize;
  }

  /**
   * Check if the buffer is empty.
   */
  isEmpty(): boolean {
    return this.currentSize === 0;
  }

  /**
   * Get the number of chunks in the buffer.
   */
  chunkCount(): number {
    return this.buffer.length;
  }
}
