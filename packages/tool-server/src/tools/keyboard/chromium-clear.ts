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
import { randomUUID } from "node:crypto";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { InvalidToolInputError } from "../../utils/capability";

// The probe parks the element it resolved on `window` so the re-read afterwards
// can measure THAT element rather than whatever holds focus by then.
//
// The slot name is generated per call, not fixed. Two reasons, both measured:
// nothing serializes tool calls against a device (the CDP client writes
// immediately and the registry hands concurrent calls the same session), so two
// clears sharing one slot interleave — B's probe overwrites A's element, or B's
// release deletes the slot before A reads it and A reports a silent success. And
// a fixed name is a slot the page can squat on: a non-writable decoy property
// made every clear on that page report success forever. A fresh name per call
// makes both far harder to hit. (`crypto.randomUUID` is the same shape
// `cdp-client`'s `evaluateWithBinding` uses to key its own callbacks.)
function newTargetHandle(): string {
  return `__argentKeyboardClearTarget_${randomUUID().replace(/-/g, "")}`;
}

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
 * `activeElement`, `body` and `documentElement` are all read through the
 * `Document.prototype` accessors because the document's named getter is
 * `[LegacyOverrideBuiltIns]`: `<form name="activeElement">`, `<img name="body">`
 * and `<form name="documentElement">` each shadow the property they are named
 * after. Reading `doc.body` directly is how the two sentinels below get handed a
 * page-controlled element and hand the caller the wrong half of the refusal.
 * Same reasoning, and same technique, as the describe DOM walker, which guards
 * the identical read (`getDocBody = protoGetter(docProto, "body")`).
 *
 * Returns a JSON string rather than an object. Not a convention borrowed from
 * the sibling CDP helpers — `chromium-server/clipboard.ts` and
 * `chromium-server/storage.ts` both return objects through `returnByValue` — but
 * a local one: `evaluateJson`'s `typeof raw !== "string"` guard is what makes an
 * unreadable page fall to the best-effort branch, so the probes and that guard
 * have to agree. Returning an object here would put every clear on the
 * best-effort branch silently.
 */
// Exported for test/keyboard-clear-probe.test.ts, which evals it against a mock
// DOM: it runs inside the page, so the rest of the suite can only mock what it
// returns and every verdict it computes would otherwise rest on a manual
// browser session alone.
export const focusedEditableProbe = (handle: string) => `(() => {
  // What a user pressing "select all" on THIS machine would send, so the page
  // sees the real chord. Read from the renderer, not the tool-server host — CDP
  // reaches remote renderers through a forwarded local port. Resolved OUTSIDE
  // the try so the catch below can still report it: the chord is dispatched even
  // when the page could not be read, and it should still be the native one.
  let mac = false;
  try { mac = /Mac|iPhone|iPad/i.test((navigator && navigator.platform) || ""); } catch (e) {}
  try {
    const docProto = typeof Document === "undefined" ? {} : Document.prototype;
    const protoGet = (name) => (Object.getOwnPropertyDescriptor(docProto, name) || {}).get;
    const activeOf = protoGet("activeElement");
    const bodyOf = protoGet("body");
    const rootOf = protoGet("documentElement");
    const active = (d) => (activeOf ? activeOf.call(d) : d.activeElement);
    const bodyOfDoc = (d) => (bodyOf ? bodyOf.call(d) : d.body);
    const rootOfDoc = (d) => (rootOf ? rootOf.call(d) : d.documentElement);
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
    // Body / documentElement focus means "nothing is focused" — UNLESS the body
    // is itself the editing host. \`document.designMode = "on"\`, TinyMCE in its
    // default iframe mode and CKEditor 4 classic all put
    // \`<body contenteditable="true">\` inside the editor iframe, which is exactly
    // what the descent above exists to reach; Blink clears it correctly, so
    // refusing it would refuse a working clear and tell the caller to focus the
    // field it had already focused. The check is ordered before the sentinel
    // rather than left to the \`isContentEditable\` branch further down, which the
    // sentinel would otherwise shadow.
    if (!el) return JSON.stringify({ verdict: "none", mac });
    if ((el === bodyOfDoc(doc) || el === rootOfDoc(doc)) && el.isContentEditable !== true) {
      return JSON.stringify({ verdict: "none", mac });
    }
    const tag = (el.tagName || "").toUpperCase();
    // The id is page-controlled and unbounded, and this string reaches the
    // agent's context in an error message — cap it the way the TV blueprint caps
    // device-supplied text.
    const label = (tag + (el.id ? "#" + el.id : "")).slice(0, 60);
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
      window[${JSON.stringify(handle)}] = el;
      return JSON.stringify({
        verdict: "editable", label, mac, parked: window[${JSON.stringify(handle)}] === el,
        // A password field is cleared like any other, but its LENGTH is
        // credential material and would otherwise reach the agent's context in
        // the failure message. Flag it so that message reports no count.
        secret: (el.type || "") === "password",
      });
    }
    if (el.isContentEditable === true) {
      window[${JSON.stringify(handle)}] = el;
      return JSON.stringify({
        verdict: "editable", label, mac, parked: window[${JSON.stringify(handle)}] === el,
      });
    }
    // Anything else is refused, INCLUDING a custom element whose shadow root is
    // closed and might hold an editable inside. That case is real, but a closed
    // root is indistinguishable from a plain focusable custom element holding
    // nothing editable (\`shadowRoot\` is null for both), and treating the whole
    // class as "can't tell" was measurably worse: the chord then no-ops, leaves
    // a document-wide selection, and the tool reports \`cleared: true\` with the
    // accompanying text unwritten — issue #449 exactly. Refusing costs a working
    // clear on closed-shadow components; guessing costs silent data corruption.
    return JSON.stringify({ verdict: "not-editable", label, mac });
  } catch (e) {
    return JSON.stringify({ verdict: "unknown", mac });
  }
})()`;

/**
 * Re-reads the element the probe parked, and releases it.
 *
 * `tracked: false` means the element is gone — the page navigated, or the probe
 * never parked one — which is not evidence either way.
 *
 * `focused` answers a second question the caller needs: does the element still
 * hold focus? Clearing routinely moves it — a field that blurs once empty, an
 * app that advances to the next input — and the characters of a combined
 * `{ clear, text }` are dispatched at whatever holds focus THEN, not at the
 * element that was emptied. `getRootNode().activeElement` is the right test for
 * that on every shape the probe can park: a shadow root and a (sub)document both
 * expose `activeElement`, and it is scoped to the tree the element actually
 * lives in.
 */
// Exported for test/keyboard-clear-probe.test.ts — see focusedEditableProbe.
export const clearedTargetProbe = (handle: string) => `(() => {
  try {
    const el = window[${JSON.stringify(handle)}];
    delete window[${JSON.stringify(handle)}];
    if (!el) return JSON.stringify({ tracked: false });
    let focused = false;
    try {
      const root = el.getRootNode ? el.getRootNode() : null;
      focused = !!root && root.activeElement === el;
    } catch (e) { focused = false; }
    // A page that replaces the field on edit (the React remount pattern) leaves
    // this node detached and holding its OLD value forever, while the live field
    // really was cleared. A stale read there is a false failure, so a detached
    // node counts as "cannot tell" rather than as residue.
    if (el.isConnected === false) return JSON.stringify({ tracked: false });
    const tag = (el.tagName || "").toUpperCase();
    const form = tag === "INPUT" || tag === "TEXTAREA";
    const bad = form && !!(el.validity && el.validity.badInput);
    const value = form ? (el.value || "") : (el.textContent || "");
    return JSON.stringify({
      tracked: true,
      focused,
      secret: (el.type || "") === "password",
      length: bad ? Math.max(1, value.length) : value.length,
    });
  } catch (e) {
    return JSON.stringify({ tracked: false });
  }
})()`;

export interface FocusedEditable {
  verdict: "editable" | "not-editable" | "read-only" | "none" | "unknown";
  label?: string;
  mac?: boolean;
  /** True for a password input, whose length must not be echoed back. */
  secret?: boolean;
  /** False when the page refused the slot assignment — then nothing was parked. */
  parked?: boolean;
}

export interface ClearedTarget {
  tracked: boolean;
  /** Whether the cleared element still holds focus in its own root. */
  focused?: boolean;
  secret?: boolean;
  length?: number;
}

/**
 * What {@link clearChromiumField} observed, for the caller that types next.
 *
 * `keptFocus: undefined` means the page could not be read, so nothing is known —
 * the same best-effort branch the emptiness check falls to.
 */
export interface ClearOutcome {
  keptFocus?: boolean;
  /** The element label the probe reported, for the caller's error message. */
  label?: string;
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
async function readFocusedEditable(api: ChromiumCdpApi, handle: string): Promise<FocusedEditable> {
  const read = await evaluateJson<FocusedEditable>(api, focusedEditableProbe(handle));
  if (read) return read;
  // `evaluate` itself failed, so the renderer never got to report its platform.
  // The chord is still dispatched on this path, so it should still be the native
  // one; the host is the best remaining proxy, since a Chromium target is found
  // by probing CDP ports on this machine. (The probe's own catch carries `mac`,
  // so this covers only the case where the call never returned a value at all.)
  return { verdict: "unknown", mac: process.platform === "darwin" };
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
export async function clearChromiumField(api: ChromiumCdpApi): Promise<ClearOutcome> {
  const handle = newTargetHandle();
  const before = await readFocusedEditable(api, handle);
  if (before.verdict === "none" || before.verdict === "not-editable") {
    // Well-formed request against a page that cannot serve it — a 400, the same
    // treatment the un-typeable-character rejections get, and thrown before any
    // dispatch so no document-wide selection is left behind.
    //
    // The two halves get different advice: with nothing focused, tapping the
    // field fixes it; with a non-text element focused (a <select>, a date
    // picker, a custom element) tapping again will not, and saying so avoids
    // sending the caller into a retry loop.
    throw new InvalidToolInputError(
      before.label
        ? `keyboard clear: the focused element ${before.label} is not a text field, so there ` +
            `is nothing to empty. Blink's select-all is not scoped to a field, so clearing here ` +
            `would select the page instead. Focus a text input, or use the element's own control.`
        : `keyboard clear: no editable element has focus. Blink's select-all is not scoped to ` +
            `a field, so clearing here would select the page instead of emptying an input. Tap ` +
            `the field first, then clear.`,
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
  // The release runs in a `finally` so a parked node is never left pinning a
  // detached subtree when the dispatch throws — the handle is the sole retainer
  // (confirmed with a WeakRef + forced GC), and a per-call slot name means a
  // leaked one is never overwritten by the next clear.
  let after: ClearedTarget | undefined;
  try {
    await api.dispatchKeyEvent({
      type: "rawKeyDown",
      ...selectAllKey,
      commands: ["selectAll", "deleteBackward"],
    });
    await api.dispatchKeyEvent({ type: "keyUp", ...selectAllKey });
  } finally {
    after = await evaluateJson<ClearedTarget>(api, clearedTargetProbe(handle));
  }

  // `unknown` before means the page was unreadable, so no element was parked and
  // there is nothing to verify against; `parked: false` means the assignment
  // itself did not take (a page can pre-define the slot non-writable). Either
  // way, stay best-effort rather than inventing a failure.
  if (before.verdict !== "editable" || before.parked === false) return { label: before.label };

  // The re-read measures the element the probe parked, NOT whatever holds focus
  // now. Clearing routinely moves focus (a page that blurs on empty, a
  // re-render, an app shortcut), so `activeElement` afterwards cannot tell
  // "emptied, then focus moved" from "never emptied, and focus moved" — and the
  // second is exactly what an app cancelling the chord produces.
  if (!after?.tracked) return { label: before.label };
  const remaining = after.length ?? 0;
  if (remaining === 0) return { keptFocus: after.focused === true, label: before.label };

  const held = after.secret || before.secret ? "its contents" : `${remaining} character(s)`;
  throw new FailureError(
    `keyboard clear: ${before.label ?? "the field"} still holds ${held} ` +
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
