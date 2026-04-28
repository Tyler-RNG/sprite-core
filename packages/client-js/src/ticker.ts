/**
 * Timing abstraction for frame advancement. The default implementation uses
 * `setTimeout`; tests inject a fake ticker that advances virtual time. The
 * Kotlin + Swift ports expose the same seam.
 */
export interface Ticker {
  delay(ms: number): Promise<void>;
}

export class SystemTicker implements Ticker {
  delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
