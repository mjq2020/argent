export interface KeyboardParams {
  udid: string;
  /** Text to type character by character. */
  text?: string;
  /**
   * Named key to press (enter, escape, arrow-*, f1–f12). Not valid on TV
   * targets, and never set alongside `text` — the tool rejects that request
   * shape (see ./index.ts), so a backend sees at most one of the two.
   */
  key?: string;
  /**
   * Empty the focused field (select-all, then delete) before typing `text`.
   * Not valid on Vega or TV targets. Order within one call: clear → text → key.
   */
  clear?: boolean;
  /** Delay in ms between key presses (default 50). */
  delayMs?: number;
}

export interface KeyboardResult {
  typed: string;
  keys: number;
  /** Present (and `true`) only when `clear` was requested and performed. */
  cleared?: boolean;
}
