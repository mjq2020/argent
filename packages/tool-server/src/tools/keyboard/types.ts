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
   * Empty the focused field before typing `text`. Not valid on Vega or TV
   * targets. Order within one call: clear → text → key.
   *
   * How it is done differs by backend — a select-all + delete on iOS, Chromium
   * and Android levels with `input keycombination`; caret-to-end-of-line plus
   * one backspace per character on older Android levels, which is therefore
   * line-scoped rather than buffer-scoped.
   */
  clear?: boolean;
  /** Delay in ms between key presses (default 50). */
  delayMs?: number;
}

export interface KeyboardResult {
  typed: string;
  keys: number;
  /**
   * Present (and `true`) only when `clear` was requested and the clear
   * completed without error. It never appears on a failed clear: a clear that
   * cannot take effect throws instead of returning, so `{ clear, text }` can
   * never report success having appended to a value that survived.
   *
   * How strongly it is evidenced varies with what the backend can observe.
   * Chromium reads the field back and fails if it is not empty; Android parses
   * the `input keycombination` output so a level without the subcommand takes
   * the delete path rather than a one-character backspace; the iOS HID
   * transport is fire-and-forget and cannot read the field at all, so there it
   * means the chord was dispatched to a focused field.
   */
  cleared?: boolean;
}
