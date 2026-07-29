/**
 * The Chromium `clear`: select the focused field's contents and delete them,
 * then confirm it actually happened.
 *
 * Split out of `platforms/chromium.ts` because the confirmation is most of the
 * work. On this backend a clear can silently do nothing in more ways than the
 * key dispatch can report — `Input.dispatchKeyEvent` resolves successfully for
 * every one of them (measured against Chrome 150; the CDP reply carries no
 * error):
 *
 *   - nothing editable holds focus (a tap that missed its target) — Blink's
 *     `selectAll` is not scoped to a field, so it selects the whole DOCUMENT
 *     and `deleteBackward` then no-ops for want of an editing host;
 *   - the page cancels the key in a `keydown` handler;
 *   - a rich-text editor (Lexical/ProseMirror/Slate) cancels the `beforeinput`;
 *   - the field is `readonly`;
 *   - the embedded Chromium predates the `commands` parameter, which CDP
 *     ignores silently along with any other unknown field.
 *
 * Reporting `cleared: true` through any of those is the silent-no-op class this
 * parameter exists to prevent (issue #449) — and the one a combined
 * `{ clear, text }` turns into corrupt data, since the new text then lands on
 * the value that was supposed to be gone. Chromium is also the one backend
 * where checking is nearly free: `evaluate` is already on `ChromiumCdpApi`.
 *
 * So the field is read before and after: a clear that cannot take effect is
 * refused before anything is dispatched (which also avoids leaving a
 * document-wide selection behind), and one that had no effect is reported as
 * the failure it is.
 *
 * Where the page cannot be read at all — `evaluate` throws, or focus sits in a
 * cross-origin iframe whose document is unreachable — this degrades to
 * best-effort and dispatches anyway, matching how the flow `type` directive
 * treats an unconfirmable focus (`flow-actions.ts` `waitForFocus`). Refusing
 * there would break clears that work today for the sake of a check that is
 * merely blind.
 */
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { InvalidToolInputError } from "../../utils/capability";

/**
 * Reads whatever editable element holds focus, across shadow roots and
 * same-origin iframes.
 *
 * `activeElement` alone is both too weak and too strong as a focus test
 * (measured on Chrome 150): with focus inside an open shadow root the top-level
 * `activeElement` is the HOST element, and with focus inside a same-origin
 * iframe it is the `<iframe>` — yet a clear works correctly in both. Meanwhile a
 * focused `<button>` is a perfectly good `activeElement` and produces the same
 * useless document-wide selection as body focus. So the probe descends to the
 * innermost active element and then asks whether THAT one is a text field.
 *
 * `activeElement` is read through the `Document.prototype` accessor because the
 * document's named getter is `[LegacyOverrideBuiltIns]`: a `<form
 * name="activeElement">` shadows it. Same reasoning, and same technique, as the
 * describe DOM walker.
 *
 * Returns a JSON string (not an object) so the value crosses `Runtime.evaluate`
 * as a primitive, the same way the chromium clipboard and storage helpers do.
 */
const FOCUSED_EDITABLE_PROBE = `(() => {
  try {
    const docProto = typeof Document === "undefined" ? {} : Document.prototype;
    const activeOf = (Object.getOwnPropertyDescriptor(docProto, "activeElement") || {}).get;
    const active = (d) => (activeOf ? activeOf.call(d) : d.activeElement);
    let doc = document;
    let el = active(doc);
    // Bounded: a malformed page could otherwise cycle host → shadow → host.
    for (let hop = 0; hop < 32 && el; hop++) {
      const tag = (el.tagName || "").toUpperCase();
      if (tag === "IFRAME" || tag === "FRAME") {
        let inner = null;
        try { inner = el.contentDocument; } catch (e) { inner = null; }
        // Cross-origin: unreadable by design, so report "can't tell" rather
        // than a wrong verdict.
        if (!inner) return JSON.stringify({ verdict: "unknown" });
        doc = inner;
        el = active(inner);
        continue;
      }
      const shadow = el.shadowRoot;
      if (shadow && shadow.activeElement) { el = shadow.activeElement; continue; }
      break;
    }
    const selection = String((doc.getSelection && doc.getSelection()) || "").length;
    if (!el || el === doc.body || el === doc.documentElement) {
      return JSON.stringify({ verdict: "none", selection });
    }
    const tag = (el.tagName || "").toUpperCase();
    const label = tag + (el.id ? "#" + el.id : "");
    const contentEditable = el.isContentEditable === true;
    // Every <input> type that holds no user-editable text: a clear against one
    // is meaningless, and dispatching would select the document instead.
    const opaqueInput = /^(button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/i;
    const editable =
      contentEditable ||
      tag === "TEXTAREA" ||
      (tag === "INPUT" && !opaqueInput.test(el.type || "text"));
    if (!editable) return JSON.stringify({ verdict: "not-editable", label, selection });
    if (el.readOnly === true || el.disabled === true) {
      return JSON.stringify({ verdict: "read-only", label, selection });
    }
    const value = contentEditable ? (el.textContent || "") : (el.value || "");
    return JSON.stringify({ verdict: "editable", label, length: value.length, selection });
  } catch (e) {
    return JSON.stringify({ verdict: "unknown" });
  }
})()`;

interface FocusedEditable {
  verdict: "editable" | "not-editable" | "read-only" | "none" | "unknown";
  label?: string;
  length?: number;
  selection?: number;
}

/** Never throws: an unreadable page is reported as `unknown`, not as a failure. */
async function readFocusedEditable(api: ChromiumCdpApi): Promise<FocusedEditable> {
  let raw: unknown;
  try {
    raw = await api.evaluate(FOCUSED_EDITABLE_PROBE, { returnByValue: true });
  } catch {
    return { verdict: "unknown" };
  }
  if (typeof raw !== "string") return { verdict: "unknown" };
  try {
    return JSON.parse(raw) as FocusedEditable;
  } catch {
    return { verdict: "unknown" };
  }
}

// CDP's `Input.dispatchKeyEvent` modifier bitmask: 2 = Ctrl, 4 = Meta. Send the
// chord the host's own users press, so the event the page sees is the real one.
const CDP_MODIFIER_CTRL = 2;
const CDP_MODIFIER_META = 4;

function selectAllModifier(): number {
  // A Chromium target is discovered by probing CDP ports on this machine, so
  // the app runs on this platform and its key bindings are this platform's.
  return process.platform === "darwin" ? CDP_MODIFIER_META : CDP_MODIFIER_CTRL;
}

/**
 * Empty the focused field. Resolves when the field was observed empty
 * afterwards, or when the page could not be read; throws otherwise.
 *
 * The editing itself rides `commands` on the `rawKeyDown` rather than being
 * driven by the modifier — see the `commands` doc on `KeyEventArgs` — but the
 * modifier is set as well, so that what the page receives is a select-all chord
 * and not a bare `a` keypress. Both editing commands ride the same event so
 * Blink applies them in order, which fires `oninput` once (`deleteContentBackward`)
 * and leaves a controlled/React input correctly updated.
 */
export async function clearChromiumField(api: ChromiumCdpApi): Promise<void> {
  const before = await readFocusedEditable(api);
  if (before.verdict === "none" || before.verdict === "not-editable") {
    // Well-formed request against a page that cannot serve it — a 400, the same
    // treatment the un-typeable-character rejections get, and thrown before any
    // dispatch so no document-wide selection is left behind.
    throw new InvalidToolInputError(
      `keyboard clear: no editable element has focus` +
        (before.label ? ` (focus is on ${before.label})` : "") +
        `. Blink's select-all is not scoped to a field, so clearing here would select the ` +
        `page instead of emptying an input. Tap the field first, then clear.`,
      {
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_NO_EDITABLE_FOCUS,
        failure_stage: "keyboard_clear_focus_chromium",
        error_kind: "unsupported",
      }
    );
  }
  if (before.verdict === "read-only") {
    throw new InvalidToolInputError(
      `keyboard clear: the focused element ${before.label ?? ""} is read-only, so its ` +
        `contents cannot be deleted.`,
      {
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_NO_EDITABLE_FOCUS,
        failure_stage: "keyboard_clear_readonly_chromium",
        error_kind: "unsupported",
      }
    );
  }

  const modifiers = selectAllModifier();
  const selectAllKey = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers };
  await api.dispatchKeyEvent({
    type: "rawKeyDown",
    ...selectAllKey,
    commands: ["selectAll", "deleteBackward"],
  });
  await api.dispatchKeyEvent({ type: "keyUp", ...selectAllKey });

  // `unknown` before means the page was unreadable, so there is nothing to
  // verify against — stay best-effort rather than inventing a failure.
  if (before.verdict === "unknown") return;

  // Only POSITIVELY observed residue is a failure. Any other after-state — the
  // field blurred, was replaced, or became unreadable — is the page reacting to
  // its own emptying, not evidence the clear was ignored, and failing on it
  // would break clears that work. Every failure mode this check exists for
  // (a cancelled keydown, a cancelled `beforeinput`, a Chromium that drops
  // `commands`) leaves the same field focused and still holding its value.
  const after = await readFocusedEditable(api);
  if (after.verdict !== "editable") return;
  const remaining = after.length ?? 0;
  if (remaining === 0) return;

  throw new FailureError(
    `keyboard clear: the field still holds ${remaining} character(s) after the ` +
      `select-all + delete. The page most likely cancelled the key or the ` +
      `\`beforeinput\` (a rich-text editor does this), or this Chromium build ignores ` +
      `CDP editing commands. The field was NOT emptied — do not treat a following ` +
      `\`text\` as a replacement.`,
    {
      error_code: FAILURE_CODES.KEYBOARD_CLEAR_INEFFECTIVE,
      failure_stage: "keyboard_clear_verify_chromium",
      failure_area: "tool_server",
      error_kind: "unsupported",
    }
  );
}
