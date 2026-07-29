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

// Where the probe parks the element it resolved, so the re-read afterwards can
// measure THAT element rather than whatever holds focus by then. Namespaced
// because it lives on the page's own `window`.
const TARGET_HANDLE = "__argentKeyboardClearTarget";

/**
 * Resolves the editable element that holds focus — across shadow roots and
 * same-origin iframes — and remembers it on `window` for the re-read.
 *
 * `activeElement` alone is both too weak and too strong as a focus test
 * (measured on Chrome 150): with focus inside an open shadow root the top-level
 * `activeElement` is the HOST element, and with focus inside a same-origin
 * iframe it is the `<iframe>` — yet a clear works correctly in both. Meanwhile a
 * focused `<button>` is a perfectly good `activeElement` and produces the same
 * useless document-wide selection as body focus. So the probe descends to the
 * innermost active element and then asks whether THAT one is a text field.
 *
 * Parking the element is what makes the verification unambiguous. Clearing a
 * field routinely moves focus — a page that blurs on empty, a node replaced by
 * a re-render, an app shortcut that jumps elsewhere — so re-reading
 * `activeElement` afterwards cannot tell "emptied, then focus moved" from
 * "never emptied, and focus moved". Re-reading the SAME element can.
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
    // What a user pressing "select all" on THIS machine would send, so the page
    // sees the real chord. Read from the renderer, not the tool-server host —
    // CDP reaches remote renderers through a forwarded local port.
    const mac = /Mac|iPhone|iPad/i.test((navigator && navigator.platform) || "");
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
        if (!inner) return JSON.stringify({ verdict: "unknown", mac });
        doc = inner;
        el = active(inner);
        continue;
      }
      const shadow = el.shadowRoot;
      if (shadow && shadow.activeElement) { el = shadow.activeElement; continue; }
      break;
    }
    if (!el || el === doc.body || el === doc.documentElement) {
      return JSON.stringify({ verdict: "none", mac });
    }
    const tag = (el.tagName || "").toUpperCase();
    const label = tag + (el.id ? "#" + el.id : "");
    // Form controls first: \`isContentEditable\` is INHERITED, so an <input>
    // inside a contenteditable host reports true, and reading its textContent
    // (always "") would make every verification pass vacuously. A <textarea>
    // there is worse — textContent is its DEFAULT value and never tracks
    // \`value\`, so a clear that worked would look like a failure.
    const formControl = tag === "INPUT" || tag === "TEXTAREA";
    // Every <input> type that holds no user-editable text. The temporal types
    // are in here because the chord no-ops against them and leaves a selection
    // behind — measured on Chrome 150.
    const opaqueInput =
      /^(button|submit|reset|checkbox|radio|file|image|range|color|hidden|date|time|datetime-local|month|week)$/i;
    if (formControl) {
      if (tag === "INPUT" && opaqueInput.test(el.type || "text")) {
        return JSON.stringify({ verdict: "not-editable", label, mac });
      }
      if (el.readOnly === true) return JSON.stringify({ verdict: "read-only", label, mac });
      window[${JSON.stringify(TARGET_HANDLE)}] = el;
      return JSON.stringify({ verdict: "editable", label, length: (el.value || "").length, mac });
    }
    if (el.isContentEditable === true) {
      window[${JSON.stringify(TARGET_HANDLE)}] = el;
      return JSON.stringify({
        verdict: "editable", label, length: (el.textContent || "").length, mac,
      });
    }
    // A custom element with a CLOSED shadow root is indistinguishable from an
    // ordinary non-editable node — \`shadowRoot\` is null either way — but the
    // clear works against one (verified: a closed-shadow <input> cleared
    // normally). Refusing would be a hard regression for design-system
    // components, so report "can't tell" and let the caller stay best-effort.
    if (tag.indexOf("-") !== -1) return JSON.stringify({ verdict: "unknown", mac });
    return JSON.stringify({ verdict: "not-editable", label, mac });
  } catch (e) {
    return JSON.stringify({ verdict: "unknown" });
  }
})()`;

/**
 * Re-reads the element the probe parked, and releases it.
 *
 * `tracked: false` means the element is gone — the page navigated, or the probe
 * never parked one — which is not evidence either way.
 */
const CLEARED_TARGET_PROBE = `(() => {
  try {
    const el = window[${JSON.stringify(TARGET_HANDLE)}];
    delete window[${JSON.stringify(TARGET_HANDLE)}];
    if (!el) return JSON.stringify({ tracked: false });
    const tag = (el.tagName || "").toUpperCase();
    const value = tag === "INPUT" || tag === "TEXTAREA" ? (el.value || "") : (el.textContent || "");
    return JSON.stringify({ tracked: true, length: value.length });
  } catch (e) {
    return JSON.stringify({ tracked: false });
  }
})()`;

interface FocusedEditable {
  verdict: "editable" | "not-editable" | "read-only" | "none" | "unknown";
  label?: string;
  length?: number;
  mac?: boolean;
}

interface ClearedTarget {
  tracked: boolean;
  length?: number;
}

async function evaluateJson<T>(api: ChromiumCdpApi, expression: string): Promise<T | undefined> {
  let raw: unknown;
  try {
    raw = await api.evaluate(expression, { returnByValue: true });
  } catch {
    return undefined;
  }
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Never throws: an unreadable page is reported as `unknown`, not as a failure. */
async function readFocusedEditable(api: ChromiumCdpApi): Promise<FocusedEditable> {
  return (
    (await evaluateJson<FocusedEditable>(api, FOCUSED_EDITABLE_PROBE)) ?? { verdict: "unknown" }
  );
}

// CDP's `Input.dispatchKeyEvent` modifier bitmask: 2 = Ctrl, 4 = Meta.
const CDP_MODIFIER_CTRL = 2;
const CDP_MODIFIER_META = 4;

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
 *
 * Neither form of the key is universally safe from the page, which is why the
 * result is verified rather than assumed: unmodified, any shortcut bound to a
 * bare `a` fires and can cancel the edit; modified, an app that binds the
 * platform select-all chord can cancel it instead. The modifier is the one a
 * real user would send, so it is what an app is entitled to intercept — and if
 * it does, the check below reports the clear as the failure it is instead of
 * letting a following `text` append to the surviving value.
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

  const modifiers = before.mac ? CDP_MODIFIER_META : CDP_MODIFIER_CTRL;
  const selectAllKey = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers };
  await api.dispatchKeyEvent({
    type: "rawKeyDown",
    ...selectAllKey,
    commands: ["selectAll", "deleteBackward"],
  });
  await api.dispatchKeyEvent({ type: "keyUp", ...selectAllKey });

  // `unknown` before means the page was unreadable, so no element was parked and
  // there is nothing to verify against — stay best-effort rather than inventing
  // a failure.
  if (before.verdict === "unknown") return;

  // Re-read the element the probe parked, NOT whatever holds focus now. Clearing
  // routinely moves focus (a page that blurs on empty, a re-render, an app
  // shortcut), so `activeElement` afterwards cannot tell "emptied, then focus
  // moved" from "never emptied, and focus moved" — and the second is exactly
  // what an app cancelling the chord produces.
  const after = await evaluateJson<ClearedTarget>(api, CLEARED_TARGET_PROBE);
  if (!after?.tracked) return;
  const remaining = after.length ?? 0;
  if (remaining === 0) return;

  throw new FailureError(
    `keyboard clear: ${before.label ?? "the field"} still holds ${remaining} character(s) ` +
      `after the select-all + delete. The page most likely cancelled the key or the ` +
      `\`beforeinput\` (a rich-text editor, or an app that binds the select-all chord, does ` +
      `this), or this Chromium build ignores CDP editing commands. The field was NOT ` +
      `emptied — do not treat a following \`text\` as a replacement.`,
    {
      error_code: FAILURE_CODES.KEYBOARD_CLEAR_INEFFECTIVE,
      failure_stage: "keyboard_clear_verify_chromium",
      failure_area: "tool_server",
      error_kind: "unsupported",
    }
  );
}
