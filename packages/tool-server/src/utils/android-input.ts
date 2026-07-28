/**
 * Android key / text / button injection over `adb shell input`.
 *
 * The bundled simulator-server injects keys as USB-HID events, which the guest
 * only receives when the AVD exposes a hardware keyboard (`hw.keyboard = yes`).
 * That is the default, but CI / headless AVDs are frequently created with
 * `hw.keyboard = no` (and `hw.mainKeys = no`), where those HID events are
 * silently dropped by the guest. Because the simulator-server transport is
 * fire-and-forget, the `keyboard` and `button` tools then reported success while
 * injecting nothing — see the `button` tool's own note about silent no-ops, and
 * https://github.com/software-mansion/argent/issues/449.
 *
 * `adb shell input text` / `input keyevent` go through Android's InputManager, so
 * they land regardless of `hw.keyboard` — on emulators (any config) and physical
 * devices alike — and a non-zero exit surfaces as a thrown error (runAdb rewraps
 * it) instead of a silent success. Touch injection is unaffected and stays on the
 * simulator-server; only key/text/button events move to this transport.
 */
import { FAILURE_CODES } from "@argent/registry";
import { adbShell, shellQuote } from "./adb";
import { InvalidToolInputError } from "./capability";

// android.view.KeyEvent keycodes for the keyboard tool's named-`key` vocabulary
// (must cover every key in ../tools/keyboard/key-codes.ts NAMED_KEYS).
export const ANDROID_NAMED_KEYCODES: Record<string, number> = {
  "enter": 66, // KEYCODE_ENTER
  "return": 66, // alias of enter
  "escape": 111, // KEYCODE_ESCAPE
  "esc": 111, // alias of escape
  "backspace": 67, // KEYCODE_DEL (backspace: deletes the char before the cursor)
  // `delete` aliases backspace, not forward-delete: the shared HID vocabulary in
  // key-codes.ts (NAMED_KEYS) maps both `backspace` and `delete` to usage 42
  // (Keyboard DELETE/Backspace), so iOS types `delete` as a backspace. A named
  // key must mean the same thing on every platform, so map it to KEYCODE_DEL (67)
  // here too rather than KEYCODE_FORWARD_DEL (112).
  "delete": 67, // KEYCODE_DEL (alias of backspace — see note above)
  "tab": 61, // KEYCODE_TAB
  "space": 62, // KEYCODE_SPACE
  "arrow-up": 19, // KEYCODE_DPAD_UP
  "arrow-down": 20, // KEYCODE_DPAD_DOWN
  "arrow-left": 21, // KEYCODE_DPAD_LEFT
  "arrow-right": 22, // KEYCODE_DPAD_RIGHT
  // F1..F12 are KEYCODE_F1 (131) .. KEYCODE_F12 (142), contiguous.
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 131 + i])),
};

// android.view.KeyEvent keycodes for the button tool's Android hardware buttons
// (must cover BUTTONS_BY_PLATFORM.android in ../tools/button/index.ts).
export const ANDROID_BUTTON_KEYCODES: Record<string, number> = {
  home: 3, // KEYCODE_HOME
  back: 4, // KEYCODE_BACK
  power: 26, // KEYCODE_POWER
  volumeUp: 24, // KEYCODE_VOLUME_UP
  volumeDown: 25, // KEYCODE_VOLUME_DOWN
  appSwitch: 187, // KEYCODE_APP_SWITCH
};

// `input text` receives the string as a single argv token (we `shellQuote` it, so
// the device shell doesn't split on spaces). It reliably types only printable
// ASCII: spaces and punctuation work, but a newline can't be represented, emoji
// crash `InputShellCommand.sendText` with a NullPointerException, and other
// non-ASCII (accented letters, CJK) is silently dropped by the virtual
// KeyCharacterMap. Reject anything outside printable ASCII up front, naming the
// offending character, so the caller gets a clear error instead of a cryptic
// crash or a silently-wrong field. (`%` is handled separately — see
// `splitForVerbatimPercent` — because it is typeable but needs escaping.)
export function assertTypeableAndroidText(text: string): void {
  // Keep the newline case as its own message: it's the one non-typeable char
  // with an obvious alternative, so point the caller at it.
  if (/[\n\r]/.test(text)) {
    // Well-typed but not injectable: a caller input error (HTTP 400 via
    // InvalidToolInputError), not an internal server fault (500). A newline is
    // a character this backend can't type, so it buckets with the other
    // un-typeable-character rejections under KEYBOARD_CHARACTER_UNSUPPORTED —
    // the same telemetry code the iOS/chromium backends use (#420).
    throw new InvalidToolInputError(
      // Advice must hold on every path sharing this guard: named keys work on
      // phones/tablets but are rejected on a TV target (typeTv), where the
      // equivalent is the tv-remote select press.
      "keyboard text must not contain a newline on Android; press enter separately " +
        'instead (key: "enter" on a phone or tablet, tv-remote select on a TV)',
      {
        error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
        failure_stage: "keyboard_text_newline_android",
        error_kind: "unsupported",
      }
    );
  }
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp < 0x20 || cp > 0x7e) {
      const hex = cp.toString(16).toUpperCase().padStart(4, "0");
      // Same KEYBOARD_CHARACTER_UNSUPPORTED bucket as the iOS/chromium
      // backends' un-typeable-character rejections (#420), so telemetry for
      // this failure doesn't diverge by platform.
      throw new InvalidToolInputError(
        `keyboard text can only contain printable ASCII on Android; character "${char}" ` +
          `(U+${hex}) can't be typed via \`adb input text\` — emoji crash it and other ` +
          `non-ASCII (accented, CJK) is silently dropped. Remove it.`,
        {
          error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
          failure_stage: "keyboard_char_android",
          error_kind: "unsupported",
        }
      );
    }
  }
}

// `input text`'s `InputShellCommand.sendText` rewrites the two-char sequence `%s`
// into a single space (and does NOT unescape `%%` back to `%`), so a naive single
// `input text "100%safe"` silently types `100 afe`. Split the text so that every
// `%` is the LAST character of its segment and issue one `input text` per segment:
// within a segment a `%` is therefore never immediately followed by `s`, so
// sendText can't fire that transform, and the segments concatenate on-device to
// the exact input. A `%`-free string yields a single segment (one `input text`),
// identical to before.
//   "100%safe" → ["100%", "safe"] → "100%" + "safe" = "100%safe"
//   "%s"       → ["%", "s"]        → "%" + "s"       = "%s"
//   "%%"       → ["%", "%"]        → "%" + "%"       = "%%"
//
// Every `input text` sink flows through `injectAndroidText` below — the phone
// keyboard path directly, the Android-TV blueprint per space-free word — so
// this workaround stays single-sourced.
function splitForVerbatimPercent(text: string): string[] {
  // Each `[^%]*%` chunk ends at (and includes) a `%`; the trailing `[^%]+` catches
  // the tail after the final `%`. Every `%` thus lands at a segment boundary.
  return text.match(/[^%]*%|[^%]+/g) ?? [];
}

// `input` opens the app-process VM per call, so it is not instant; 15s comfortably
// covers a single text/keyevent injection on a slow CI emulator while still
// bounding a hung adb child.
const ADB_INPUT_TIMEOUT_MS = 15_000;

/** Type text into the focused field via `adb shell input text`. No-op for "". */
export async function injectAndroidText(serial: string, text: string): Promise<void> {
  assertTypeableAndroidText(text);
  // One `input text` per segment so a `%` never precedes an `s` on the device (see
  // `splitForVerbatimPercent`); `%`-free text is a single call, as before. An
  // empty string yields no segments (`splitForVerbatimPercent("")` → []), so this
  // is a no-op for "" without a separate guard.
  for (const segment of splitForVerbatimPercent(text)) {
    await adbShell(serial, `input text ${shellQuote(segment)}`, {
      timeoutMs: ADB_INPUT_TIMEOUT_MS,
    });
  }
}

/** Press a single android.view.KeyEvent keycode via `adb shell input keyevent`. */
export async function injectAndroidKeycode(serial: string, keycode: number): Promise<void> {
  await adbShell(serial, `input keyevent ${keycode}`, { timeoutMs: ADB_INPUT_TIMEOUT_MS });
}

// Keycodes used by the clear (select-all + delete) sequence.
const KEYCODE_CTRL_LEFT = 113;
const KEYCODE_A = 29;
const KEYCODE_DEL = 67;

// The delete-based fallback drives one key event per character through a single
// `input` invocation. Every key is delivered to the app, so the wall-clock cost
// scales with its per-keystroke work (6.9s for 150 keys against a live-filtering
// search box on API 30). Capped below the argent-mcp adapter's 30s per-request
// fetch timeout — `keyboard` is not `longRunning`, so exceeding it would have
// the client abandon the request while adb kept deleting on the device.
const ADB_CLEAR_FALLBACK_TIMEOUT_MS = 25_000;

/**
 * Empty the focused text field: select its whole contents, then delete.
 *
 * Ctrl+A is the Android select-all chord (it is what a hardware keyboard sends),
 * and `input keycombination` is the only `input` subcommand that can hold one
 * key while pressing another. Verified on a native `EditText` (Settings search)
 * and a React Native `TextInput` (Bluesky sign-in) — the field empties, the
 * placeholder returns and focus is retained.
 *
 * `keycombination` is a recent `input` subcommand; older levels do not have it
 * (measured absent on API 30, present on API 34 and 36) — and its absence
 * CANNOT be detected by exit code. `input` reports the bad subcommand by
 * throwing IllegalArgumentException, which `BaseCommand` catches and turns into
 * a usage dump, so the process still **exits 0**:
 *
 *     $ adb shell input keycombination 113 29   # API 30
 *     Usage: input [<source>] [-d DISPLAY_ID] <command> [<arg>...]
 *     $ echo $?
 *     0
 *
 * Detecting this by catching a throw would therefore never fire: the select-all
 * would silently do nothing, the DEL below would delete exactly ONE character,
 * and the tool would report `cleared: true` — the same silent-no-op class as
 * issue #449. So the marker is read out of the command's OUTPUT instead.
 *
 * The `2>&1` is load-bearing. Which stream carries the complaint varies by
 * level — API 30 writes the usage dump to STDERR, while API 34/36 write
 * "Unknown command: …" to stdout — and `adbShell` returns stdout only, so
 * without the redirect an API 30 device looks exactly like a success and the
 * one-character delete ships. Redirecting on the device folds both into the
 * stream we can see. Verified that a device which DOES support the subcommand
 * prints nothing on either stream, so this cannot false-reject.
 *
 * A thrown error is left to propagate as the genuine transport failure it is.
 *
 * On a level without `keycombination` the clear falls back to
 * {@link clearByDeleting}, which is exact rather than best-effort — see there.
 */
export async function injectAndroidClear(serial: string): Promise<void> {
  const out = await adbShell(
    serial,
    `input keycombination ${KEYCODE_CTRL_LEFT} ${KEYCODE_A} 2>&1`,
    { timeoutMs: ADB_INPUT_TIMEOUT_MS }
  );
  if (/unknown command|usage: input/i.test(out)) {
    await clearByDeleting(serial);
    return;
  }
  await injectAndroidKeycode(serial, KEYCODE_DEL);
}

const KEYCODE_MOVE_END = 123;

// Extra backspaces beyond the field's measured length, to absorb a character
// typed between the measurement and the delete run. Backspace on an empty field
// is a no-op, so overshooting costs only key events.
const DELETE_MARGIN = 8;

// Used when the focused field's contents cannot be measured (no focused node in
// the dump, or a password field, whose text uiautomator refuses to report).
// Comfortably covers a credential or a single-line form field; each key is ~5ms
// of the shared `input` invocation, so the whole run is well under a second of
// device time.
const BLIND_DELETE_COUNT = 160;

const ADB_DUMP_TIMEOUT_MS = 20_000;

/**
 * Empty the focused field on an Android level whose `input` has no
 * `keycombination`: move the caret to the end of the line, then backspace over
 * the contents.
 *
 * The count is measured, not guessed. A `uiautomator dump` is read first and the
 * focused node's `text` gives the exact number of characters to remove, so this
 * is not the bounded best-effort it would otherwise be — the failure mode of a
 * fixed run is that a longer field keeps its head and the typed text is appended
 * to that residue, which is precisely what `clear` exists to prevent. When the
 * text cannot be read (no focused node, or a password field — uiautomator
 * reports those empty) it falls back to BLIND_DELETE_COUNT.
 *
 * Note the dump reports an EMPTY field's hint in the same `text` attribute, so a
 * measurement can be the placeholder rather than real content. That is harmless
 * in this direction: it only ever makes the run slightly longer than needed, and
 * backspace on an empty field does nothing.
 *
 * Known limit, and the reason this is the fallback rather than the primary path:
 * `KEYCODE_MOVE_END` is end-of-LINE, not end-of-buffer, so a multi-line field
 * keeps whatever sits below the caret. Single-line inputs — every login, search
 * and form field — are exact.
 *
 * Measured on an API 30 emulator: 150 keys against the live-filtering Settings
 * search box took 6.9s wall-clock and emptied it; against an idle field the same
 * run is ~0.75s, since the cost is dominated by one `input` VM start.
 */
async function clearByDeleting(serial: string): Promise<void> {
  const count = (await measureFocusedTextLength(serial)) ?? BLIND_DELETE_COUNT;
  const dels = Array.from({ length: count + DELETE_MARGIN }, () => KEYCODE_DEL).join(" ");
  // One invocation for the whole run: `input keyevent` accepts a keycode list,
  // and the per-key cost is negligible next to starting the app-process VM.
  await adbShell(serial, `input keyevent ${KEYCODE_MOVE_END} ${dels}`, {
    timeoutMs: ADB_CLEAR_FALLBACK_TIMEOUT_MS,
  });
}

/**
 * Characters in the focused field, or undefined when it cannot be read. Parsed
 * straight out of a `uiautomator dump` rather than the describe stack, so this
 * util stays dependency-free and usable from the keyboard backend.
 */
async function measureFocusedTextLength(serial: string): Promise<number | undefined> {
  let xml: string;
  try {
    xml = await adbShell(serial, "uiautomator dump /dev/tty", {
      timeoutMs: ADB_DUMP_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
  // uiautomator emits one self-closing <node .../> per view with a fixed
  // attribute order in which `text` precedes `focused`, so match the whole tag
  // and pull `text` back out of it.
  for (const tag of xml.match(/<node\b[^>]*>/g) ?? []) {
    if (!/\bfocused="true"/.test(tag)) continue;
    // A password field reports empty text regardless of contents, so its length
    // is not evidence — fall back to the blind count instead of clearing 0.
    if (/\bpassword="true"/.test(tag)) return undefined;
    const text = /\btext="([^"]*)"/.exec(tag)?.[1];
    if (text === undefined) return undefined;
    // The dump is XML-escaped; decode so the length is in real characters.
    const decoded = text
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
    return [...decoded].length;
  }
  return undefined;
}

/**
 * Resolve a named key (keyboard tool `key` vocabulary) to its
 * android.view.KeyEvent keycode, or throw. Split out from the injection so a
 * caller can validate a key name without pressing it — the keyboard backend does
 * that before a `clear`, which must not empty a field for a request it then
 * rejects. Mirrors `resolveVegaNamedKeycode`.
 */
export function resolveAndroidNamedKeycode(name: string): number {
  const lower = name.toLowerCase();
  // Own-property check: `key` is a free string, so a prototype key like
  // "constructor" would otherwise pass the nullish guard with a garbage value
  // (Object.prototype.constructor) and shell out a broken keyevent instead of
  // rejecting as an unknown key.
  const keycode = Object.hasOwn(ANDROID_NAMED_KEYCODES, lower)
    ? ANDROID_NAMED_KEYCODES[lower]
    : undefined;
  if (keycode == null) {
    // Unknown key name is a caller input error (HTTP 400), not a 500. Carry the
    // same KEYBOARD_KEY_UNSUPPORTED telemetry code the iOS/chromium/vega backends
    // use (#420), so "unknown named key" buckets uniformly across platforms.
    throw new InvalidToolInputError(
      `Unknown key "${name}". Supported: ${Object.keys(ANDROID_NAMED_KEYCODES).join(", ")}`,
      {
        error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
        failure_stage: "keyboard_named_key_android",
        error_kind: "unsupported",
      }
    );
  }
  await injectAndroidKeycode(serial, keycode);
}
