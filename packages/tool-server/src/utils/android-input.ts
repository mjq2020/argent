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
import {
  attrIsTrue,
  parseUiAutomatorXml,
} from "../tools/describe/platforms/android/uiautomator-parser";
import { adbShell, shellQuote } from "./adb";
import { ANDROID_UI_DUMP_TIMEOUT_MS, dumpAndroidUiXml } from "./android-ui-dump";
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

/**
 * Wall-clock budget for one whole clear, shared across every adb round trip it
 * makes.
 *
 * A clear is up to three sequential calls (the `keycombination` probe, then on a
 * legacy level a `uiautomator dump` and the delete run), and `text` / `key`
 * injection still follows it inside the same request. `keyboard` does not
 * declare `longRunning`, so the argent-mcp adapter applies its 30s per-request
 * fetch timeout to the lot (`FETCH_TIMEOUT_MS`, mcp-server.ts) — which means the
 * legs CANNOT each be sized against 30s independently, or their worst cases sum
 * past it and the client abandons the request while adb keeps deleting on the
 * device. So they share one deadline instead.
 *
 * 20s covers the slowest path measured on API 30 (a ~2s dump plus 6.9s of
 * deletes against the live-filtering Settings search box) with room to spare.
 * It bounds the CLEAR only: `text` and `key` keep their own ADB_INPUT_TIMEOUT_MS
 * caps, which is the pre-existing budget for a call without a clear. So this
 * stops the clear from blowing the request budget on its own; it does not turn
 * the whole tool call into one deadline, which would mean threading it through
 * the text/key injectors the Android-TV blueprint shares.
 */
const ANDROID_CLEAR_BUDGET_MS = 20_000;

/**
 * Timeout for the next leg of a clear: whatever is left of the shared budget,
 * capped at that leg's own natural maximum.
 *
 * Floored at 1s rather than 0 so an already-overrun budget still attempts the
 * call — a 0ms timeout would fail every time, turning a merely slow device into
 * a hard error.
 */
function clearLegTimeout(deadline: number, cap: number): number {
  return Math.max(1_000, Math.min(cap, deadline - Date.now()));
}

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
 * CANNOT be detected by exit code. `input` reports an unknown subcommand by
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
 * Two output shapes have to be recognised because `input` words the complaint
 * differently across levels: API 30 prints the `Usage: input …` dump, and the
 * levels that phrase it as `Unknown command: …` do so for any subcommand they
 * do not have (measured by feeding them a nonsense one — they DO have
 * `keycombination`, so they never emit it for this call). Matching both keeps
 * the guard correct on a level that has neither the subcommand nor API 30's
 * wording.
 *
 * The `2>&1` is load-bearing. Which stream carries the complaint also varies —
 * API 30 writes its usage dump to STDERR — and `adbShell` returns stdout only,
 * so without the redirect an API 30 device looks exactly like a success and the
 * one-character delete ships. Redirecting on the device folds both into the
 * stream we can see. Verified that a device which DOES support the subcommand
 * prints nothing on either stream, so this cannot false-reject.
 *
 * A thrown error is left to propagate as the genuine transport failure it is.
 *
 * On a level without `keycombination` the clear falls back to
 * {@link clearByDeleting}.
 */
export async function injectAndroidClear(serial: string): Promise<void> {
  // One deadline for every leg below — see ANDROID_CLEAR_BUDGET_MS.
  const deadline = Date.now() + ANDROID_CLEAR_BUDGET_MS;
  const out = await adbShell(
    serial,
    `input keycombination ${KEYCODE_CTRL_LEFT} ${KEYCODE_A} 2>&1`,
    { timeoutMs: clearLegTimeout(deadline, ADB_INPUT_TIMEOUT_MS) }
  );
  if (/unknown command|usage: input/i.test(out)) {
    await clearByDeleting(serial, deadline);
    return;
  }
  await adbShell(serial, `input keyevent ${KEYCODE_DEL}`, {
    timeoutMs: clearLegTimeout(deadline, ADB_INPUT_TIMEOUT_MS),
  });
}

const KEYCODE_MOVE_END = 123;

// Extra backspaces beyond the field's measured length. The measurement and the
// delete run are two separate device round trips reading two different sources
// of truth — uiautomator's cached view text versus the editor's live buffer —
// so a small overshoot absorbs any skew between them (an in-flight IME
// composition, a field whose displayed text is shorter than its value).
// Backspace on an empty field is a no-op, so overshooting costs only key events.
const DELETE_MARGIN = 8;

// Used when the focused field's contents cannot be measured: no focused
// *editable* node in the dump, a password field (whose text uiautomator refuses
// to report), or a dump that failed outright. Covers any credential or
// single-line form field. Against an idle field the run costs ~0.8s, since the
// cost is dominated by one `input` VM start; against a field that does work per
// keystroke (a live-filtering search box) budget several seconds.
//
// This IS the fixed run the measurement exists to avoid, so it carries that
// shape's failure with it: a field longer than this keeps its head, and — unlike
// a measured field — there is no length to compare against MAX_DELETE_COUNT, so
// it cannot be refused either. It is accepted only because the cases that reach
// it are ones where nothing longer is plausible (a password field is the main
// one, and 160 is far past any credential).
const BLIND_DELETE_COUNT = 160;

// Longest field this path will attempt; beyond it the clear is refused rather
// than started — see clearByDeleting.
//
// Sized from the delete leg's actual share of ANDROID_CLEAR_BUDGET_MS at the
// SLOWEST rate measured on device. Every key is delivered to the app, so the
// cost is the app's per-keystroke work: 608 deletes took 42s against one live
// field (~69ms/key) versus 0.8s against an idle one. The probe and dump spend
// ~3s of the 20s budget, leaving ~17s; at 69ms/key that affords ~245 keys, so
// 200 (+ DELETE_MARGIN = 208 keys ≈ 14s at that rate) stays inside it with room
// to spare. Anything larger could time out mid-run and leave the partly-deleted
// field this refusal exists to prevent.
//
// 200 characters is well past the single-line inputs this fallback serves — a
// login, a search box, a form field.
const MAX_DELETE_COUNT = 200;

// Per-delete cost used to decide whether the run fits in what is LEFT of the
// budget. Deliberately the slow end of the measured range, not the average: the
// cost is the app's per-keystroke work, which spans 16ms/key against an idle
// native EditText to 69ms/key against a live-filtering field on API 30. Guessing
// low would let a run start that cannot finish, which is the failure this
// estimate exists to prevent — and guessing high only refuses a clear the caller
// can retry or do another way.
const SLOW_MS_PER_DELETE = 70;

/**
 * Empty the focused field on an Android level whose `input` has no
 * `keycombination`: move the caret to the end of the line, then backspace over
 * the contents.
 *
 * The count is measured where it can be. A `uiautomator dump` is read first and
 * the focused editable node's `text` gives the number of characters to remove,
 * so this is not the fixed best-effort it would otherwise be — the failure mode
 * of a fixed run is that a longer field keeps its head and the typed text is
 * appended to that residue, which is precisely what `clear` exists to prevent.
 * Where the field cannot be measured it falls back to BLIND_DELETE_COUNT, which
 * IS such a fixed run: see {@link measureFocusedTextLength} for exactly when,
 * and BLIND_DELETE_COUNT for what it covers.
 *
 * Note the dump reports an EMPTY field's hint in the same `text` attribute on
 * older levels, so a measurement can be the placeholder rather than real
 * content. That is harmless in this direction: it only ever makes the run
 * slightly longer than needed, and backspace on an empty field does nothing.
 *
 * Known limit, and the reason this is the fallback rather than the primary path:
 * `KEYCODE_MOVE_END` is end-of-LINE, not end-of-buffer, so a multi-line field
 * keeps whatever sits below the caret. Single-line inputs — every login, search
 * and form field — are emptied exactly.
 *
 * Measured on an API 30 emulator: 150 keys against the live-filtering Settings
 * search box took 6.9s wall-clock and emptied it; against an idle field the same
 * run is ~0.75s, since the cost is dominated by one `input` VM start.
 */
async function clearByDeleting(serial: string, deadline: number): Promise<void> {
  const count = (await measureFocusedTextLength(serial, deadline)) ?? BLIND_DELETE_COUNT;
  const keys = count + DELETE_MARGIN;
  // Refuse BEFORE touching the field, on BOTH grounds. A cap alone is not
  // enough: it is static, while the time left to spend is not — a cold
  // `uiautomator` on a busy emulator can take 10s of the 20s budget, and the
  // largest run the cap allows would then abort part-way through. Both checks
  // exist because they fail for different reasons: the cap says "no plausible
  // budget covers this field", the deadline says "this particular call has
  // already spent too much to start".
  const remainingMs = deadline - Date.now();
  const estimatedMs = keys * SLOW_MS_PER_DELETE;
  if (count > MAX_DELETE_COUNT || estimatedMs > remainingMs) {
    throw new InvalidToolInputError(
      `keyboard clear: the focused field holds ${count} characters, more than this Android ` +
        `level can clear within the request budget. Without \`input keycombination\` (added ` +
        `after API 30) the only available clear is one backspace per character, which is too ` +
        `slow to finish reliably past ${MAX_DELETE_COUNT}. The field was NOT modified. Clear ` +
        `it with the app's own affordance, or use an emulator on a newer API level.`,
      {
        // Its own code rather than KEYBOARD_CLEAR_INEFFECTIVE: this is a
        // caller-fixable rejection (a 400) that changed nothing, whereas
        // INEFFECTIVE is an internal fault (a 500) after the edit was attempted.
        // Sharing one code would mix the two in any dashboard slicing on it.
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_FIELD_TOO_LONG,
        failure_stage: "keyboard_clear_too_long_android",
        error_kind: "unsupported",
      }
    );
  }
  const dels = Array.from({ length: keys }, () => KEYCODE_DEL).join(" ");
  // One invocation for the whole run: `input keyevent` accepts a keycode list.
  // No floor on this timeout, unlike the read legs: the check above already
  // established the remaining budget covers the run, and killing adb part-way
  // through would leave exactly the half-deleted field this path avoids —
  // deletes already delivered to the device keep landing after the client gives
  // up.
  await adbShell(serial, `input keyevent ${KEYCODE_MOVE_END} ${dels}`, {
    timeoutMs: Math.max(1, deadline - Date.now()),
  });
}

/**
 * Characters in the focused editable field, or undefined when it cannot be read
 * — in which case {@link clearByDeleting} uses BLIND_DELETE_COUNT.
 *
 * Undefined is returned when the dump fails or the device refuses it (locked
 * screen, secure overlay), when no focused node is an `EditText`, and when the
 * focused field is a password (uiautomator reports those empty regardless of
 * contents, so a measured 0 would clear nothing).
 *
 * Restricting the measurement to `EditText` nodes is what makes a measured `0`
 * trustworthy. A dump can carry several `focused="true"` nodes — uiautomator
 * captures every window, so the IME or a systemui overlay contributes its own
 * focus — and a focused non-text container reports `text=""`. Taking the first
 * focused node in document order would read that as "the field is empty" and
 * issue only DELETE_MARGIN backspaces against a field that is not, leaving a
 * partly-cleared value reported as `cleared: true`. Where more than one editable
 * node claims focus, the longest wins: over-deleting is a no-op, under-deleting
 * is the truncation this exists to avoid.
 *
 * The XML goes through the describe stack's `parseUiAutomatorXml` rather than a
 * local regex. That parser already handles what a hand-rolled one gets wrong on
 * real dumps: a raw `>` inside a quoted attribute value (legal per XML §2.4, and
 * it does occur — a field holding `a > b` defeats a `[^>]*` tag matcher), and
 * the full entity set including numeric character references. `utils/` →
 * `tools/describe/` is an established direction here (utils/match-element-frame,
 * utils/ui-tree-match), and `blueprints/android-tv-control` already pairs this
 * module with that parser for the same focused-node purpose.
 */
async function measureFocusedTextLength(
  serial: string,
  deadline: number
): Promise<number | undefined> {
  let xml: string;
  try {
    xml = await dumpAndroidUiXml(serial, {
      timeoutMs: clearLegTimeout(deadline, ANDROID_UI_DUMP_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  // adb exits 0 even when uiautomator refused the screen; it reports that
  // in-band as an `ERROR:` line instead of a hierarchy. Same check the describe
  // path makes, minus the throw — here it just means "unmeasurable".
  if (!xml.includes("<hierarchy")) return undefined;
  const root = parseUiAutomatorXml(xml);
  if (!root) return undefined;

  let longest: number | undefined;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    stack.push(...node.children);
    const attrs = node.attrs;
    if (!attrIsTrue(attrs, "focused")) continue;
    // Same `EditText` test the TV focus walk uses for `isEditable`, so the two
    // agree on what counts as a text field.
    if (!/EditText/.test(attrs.class ?? "")) continue;
    if (attrIsTrue(attrs, "password")) return undefined;
    // An absent `text` is "unreadable", not "empty" — treating it as 0 would
    // issue DELETE_MARGIN backspaces against a field that may be full. An empty
    // field dumps `text=""`, which is present and correctly measures 0.
    const text = attrs.text;
    if (text === undefined) return undefined;
    longest = Math.max(longest ?? 0, [...text].length);
  }
  return longest;
}

/**
 * Resolve a named key (keyboard tool `key` vocabulary) to its
 * android.view.KeyEvent keycode, or throw. Split out from the injection so a
 * caller can validate a key name without pressing it — the keyboard backend does
 * that before typing, and before a `clear`, which must not empty a field for a
 * request it then rejects. Mirrors `resolveVegaNamedKeycode`.
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
  return keycode;
}

/** Press a named key (keyboard tool `key` vocabulary) on Android. */
export async function injectAndroidNamedKey(serial: string, name: string): Promise<void> {
  await injectAndroidKeycode(serial, resolveAndroidNamedKeycode(name));
}
