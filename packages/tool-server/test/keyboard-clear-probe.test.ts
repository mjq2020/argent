import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  clearedTargetProbe,
  focusedEditableProbe,
  type ClearedTarget,
  type FocusedEditable,
} from "../src/tools/keyboard/chromium-clear";

// The Chromium clear's two probes run as source strings inside the page, so the
// rest of the suite can only mock what they RETURN — every verdict they compute
// (which elements count as editable, the `isContentEditable` inheritance trap,
// the temporal input types, the parked handle, `badInput`, `isConnected`) is
// invisible to it, and a manual browser session is the only other evidence.
//
// They are pure expressions over a handful of DOM properties, so `node:vm` plus
// a hand-built `window`/`document` pins them exactly, with no new dependency.
// Every shape modelled here was checked against a real Chrome 150 first — an
// `<input>` inside a contenteditable really does report `isContentEditable`, a
// detached input really does keep `.value` while reporting `isConnected: false`,
// and a number input holding `1ee` really does report `value: ""` with
// `validity.badInput`.

const HANDLE = "__argentKeyboardClearTarget_test";

interface FakeEl {
  tagName: string;
  id?: string;
  type?: string;
  value?: string;
  textContent?: string;
  readOnly?: boolean;
  isContentEditable?: boolean;
  isConnected?: boolean;
  shadowRoot?: { activeElement: FakeEl | null } | null;
  contentDocument?: FakeDoc | null;
  validity?: { badInput: boolean };
}

interface FakeDoc {
  /** What the `Document.prototype` accessor reports — the truthful answer. */
  __active: FakeEl | null;
  /** The document's own named getter, which a page can shadow. See below. */
  activeElement: FakeEl;
  body: FakeEl;
  documentElement: FakeEl;
}

/**
 * A document whose OWN `activeElement` is a decoy.
 *
 * `document.activeElement`'s named getter is `[LegacyOverrideBuiltIns]`, so a
 * `<form name="activeElement">` shadows it — measured on Chrome 150, the own
 * property then reports `FORM` while the `Document.prototype` accessor still
 * reports the real `INPUT`. Modelling the decoy on every document is what makes
 * these tests discriminating: any read that bypasses the prototype accessor
 * picks up the FORM and produces a visibly wrong verdict, so dropping that read
 * cannot ship green.
 */
function makeDoc(active: FakeEl | null): FakeDoc {
  return {
    __active: active,
    activeElement: { tagName: "FORM", id: "decoy" },
    body: { tagName: "BODY" },
    documentElement: { tagName: "HTML" },
  };
}

/** Run a probe against a fake page, returning the parsed verdict and the window. */
function runProbe(
  expression: string,
  doc: FakeDoc,
  seedWindow: Record<string, unknown> = {},
  platform = "MacIntel"
): { result: FocusedEditable & ClearedTarget; window: Record<string, unknown> } {
  // Not a spread: copying descriptors is the whole point of the refused-park
  // case, and `{...seed}` would turn a non-writable slot into a writable one.
  const window: Record<string, unknown> = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(seedWindow)
  );
  const sandbox = {
    window,
    document: doc,
    navigator: { platform },
    Document: { prototype: {} },
    Object,
    JSON,
    Math,
    RegExp,
    String,
  };
  Object.defineProperty(sandbox.Document.prototype, "activeElement", {
    get(this: FakeDoc) {
      return this.__active;
    },
    configurable: true,
  });
  Object.assign(sandbox, { globalThis: sandbox });
  const raw = runInNewContext(expression, sandbox) as string;
  return { result: JSON.parse(raw), window };
}

const focused = (el: FakeEl | null, seed?: Record<string, unknown>, platform?: string) =>
  runProbe(focusedEditableProbe(HANDLE), makeDoc(el), seed, platform);

describe("chromium clear — focused-element probe", () => {
  it("reports a focused text input as editable and parks it", () => {
    const el: FakeEl = { tagName: "INPUT", id: "email", value: "hello123" };
    const { result, window } = focused(el);

    expect(result).toMatchObject({ verdict: "editable", label: "INPUT#email", parked: true });
    expect(window[HANDLE]).toBe(el);
  });

  it("reports nothing focused when the BODY holds focus", () => {
    // The realistic shape: a real Chrome reports `document.body` when nothing is
    // focused, never null. Feeding null instead would leave the body guard — the
    // one that actually fires in production — unpinned.
    const doc = makeDoc(null);
    doc.__active = doc.body;
    expect(runProbe(focusedEditableProbe(HANDLE), doc).result.verdict).toBe("none");
  });

  it("reports nothing focused when there is no active element at all", () => {
    expect(focused(null).result.verdict).toBe("none");
  });

  it("refuses a button — a focused non-text element is not a clear target", () => {
    const { result, window } = focused({ tagName: "BUTTON", id: "go" });
    expect(result).toMatchObject({ verdict: "not-editable", label: "BUTTON#go" });
    expect(window[HANDLE]).toBeUndefined();
  });

  it.each(["checkbox", "radio", "file", "range", "color", "date", "time", "month", "week"])(
    "refuses <input type=%s>, which holds no editable text",
    (type) => {
      expect(focused({ tagName: "INPUT", id: "x", type, value: "" }).result.verdict).toBe(
        "not-editable"
      );
    }
  );

  it.each(["text", "search", "email", "password", "url", "tel", "number"])(
    "accepts <input type=%s>",
    (type) => {
      expect(focused({ tagName: "INPUT", id: "x", type, value: "abcd" }).result.verdict).toBe(
        "editable"
      );
    }
  );

  it("accepts a plain contenteditable element", () => {
    // The rich-text-editor case this module is largely written around. Both
    // "contenteditable" cases below take the form-control branch instead, so
    // without this the contenteditable branch has no coverage at all.
    const el: FakeEl = { tagName: "DIV", id: "rt", isContentEditable: true, textContent: "hi" };
    const { result, window } = focused(el);
    expect(result).toMatchObject({ verdict: "editable", label: "DIV#rt", parked: true });
    expect(window[HANDLE]).toBe(el);
  });

  it("refuses a readonly field rather than dispatching against it", () => {
    const { result } = focused({ tagName: "INPUT", id: "total", value: "42", readOnly: true });
    expect(result).toMatchObject({ verdict: "read-only", label: "INPUT#total" });
  });

  it("classifies a form control inside a contenteditable BY TAG, not by inheritance", () => {
    // `isContentEditable` is inherited, so an <input> inside an editing host
    // reports true. Taking that branch would read its textContent — always "" —
    // and a <textarea>'s textContent is its DEFAULT value, which never tracks
    // `value`. Both are still *editable*; the branch that matters is the one the
    // release probe uses to measure them (see its own tests below).
    expect(
      focused({
        tagName: "INPUT",
        id: "i",
        value: "typed",
        textContent: "",
        isContentEditable: true,
      }).result
    ).toMatchObject({ verdict: "editable", label: "INPUT#i" });
    expect(
      focused({
        tagName: "TEXTAREA",
        id: "ta",
        value: "live",
        textContent: "stale default",
        isContentEditable: true,
      }).result
    ).toMatchObject({ verdict: "editable", label: "TEXTAREA#ta" });
  });

  it("flags a password field so its length is never echoed back", () => {
    expect(
      focused({ tagName: "INPUT", id: "pw", type: "password", value: "s3cret" }).result.secret
    ).toBe(true);
    expect(focused({ tagName: "INPUT", id: "u", type: "text", value: "bob" }).result.secret).toBe(
      false
    );
  });

  it("descends into an open shadow root, and through nested ones", () => {
    const inner: FakeEl = { tagName: "INPUT", id: "inner", value: "abc" };
    expect(
      focused({ tagName: "MY-FIELD", id: "host", shadowRoot: { activeElement: inner } }).result
    ).toMatchObject({ verdict: "editable", label: "INPUT#inner" });

    const deep: FakeEl = { tagName: "INPUT", id: "deep", value: "abc" };
    const mid: FakeEl = { tagName: "MY-INNER", shadowRoot: { activeElement: deep } };
    expect(
      focused({ tagName: "MY-OUTER", shadowRoot: { activeElement: mid } }).result
    ).toMatchObject({ verdict: "editable", label: "INPUT#deep" });
  });

  it("descends into a same-origin iframe, and through nested ones", () => {
    const inner: FakeEl = { tagName: "TEXTAREA", id: "fi", value: "abcdef" };
    expect(
      focused({ tagName: "IFRAME", id: "f", contentDocument: makeDoc(inner) }).result
    ).toMatchObject({ verdict: "editable", label: "TEXTAREA#fi" });

    const deep: FakeEl = { tagName: "INPUT", id: "deepframe", value: "x" };
    const midDoc = makeDoc({ tagName: "IFRAME", id: "g", contentDocument: makeDoc(deep) });
    expect(focused({ tagName: "IFRAME", id: "f", contentDocument: midDoc }).result).toMatchObject({
      verdict: "editable",
      label: "INPUT#deepframe",
    });
  });

  it("reports a cross-origin iframe as unknown rather than guessing", () => {
    expect(focused({ tagName: "IFRAME", id: "f", contentDocument: null }).result.verdict).toBe(
      "unknown"
    );
  });

  it("refuses a custom element instead of assuming a closed shadow root", () => {
    // A closed root is indistinguishable from a plain focusable custom element
    // holding nothing editable. Treating the class as "can't tell" made the
    // chord no-op, leave a document-wide selection, and report success.
    const { result, window } = focused({ tagName: "X-THING", id: "z", shadowRoot: null });
    expect(result).toMatchObject({ verdict: "not-editable", label: "X-THING#z" });
    expect(window[HANDLE]).toBeUndefined();
  });

  it("caps the label, which is page-controlled and reaches an error message", () => {
    const { result } = focused({ tagName: "BUTTON", id: "x".repeat(500) });
    expect(result.label!.length).toBeLessThanOrEqual(60);
  });

  it("reports the RENDERER's platform so the chord matches the page", () => {
    expect(focused({ tagName: "INPUT", value: "a" }, {}, "MacIntel").result.mac).toBe(true);
    expect(focused({ tagName: "INPUT", value: "a" }, {}, "Win32").result.mac).toBe(false);
    expect(focused({ tagName: "INPUT", value: "a" }, {}, "Linux x86_64").result.mac).toBe(false);
  });

  it("still reports the platform when the page could not be read", () => {
    // The chord is dispatched even on the unreadable path, so it should still be
    // the native one — `mac` has to survive the failure that produced `unknown`.
    const el = { tagName: "INPUT", id: "x" } as FakeEl;
    Object.defineProperty(el, "type", {
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(focused(el, {}, "MacIntel").result).toMatchObject({ verdict: "unknown", mac: true });
  });

  it("reports a park the page refused, so nothing is verified against a decoy", () => {
    // A page can pre-define the slot non-writable; the assignment then fails
    // silently (sloppy mode, no throw) and the release probe would read the
    // page's object instead of the field.
    const seed: Record<string, unknown> = {};
    Object.defineProperty(seed, HANDLE, {
      value: { tagName: "INPUT", value: "" },
      writable: false,
    });
    expect(focused({ tagName: "INPUT", id: "q", value: "hello123" }, seed).result.parked).toBe(
      false
    );
  });
});

describe("chromium clear — release probe", () => {
  const release = (seed: Record<string, unknown>) =>
    runProbe(clearedTargetProbe(HANDLE), makeDoc(null), seed);

  it("reports the parked element's remaining length and releases the slot", () => {
    const { result, window } = release({
      [HANDLE]: { tagName: "INPUT", value: "", isConnected: true },
    });
    expect(result).toMatchObject({ tracked: true, length: 0 });
    expect(window[HANDLE]).toBeUndefined();
  });

  it("reports residue when the field still holds its value", () => {
    expect(
      release({ [HANDLE]: { tagName: "INPUT", value: "hello123", isConnected: true } }).result
    ).toMatchObject({ tracked: true, length: 8 });
  });

  it("reports untracked when nothing was parked", () => {
    expect(release({}).result).toEqual({ tracked: false });
  });

  it("reports untracked for a node the page detached", () => {
    // A field replaced on edit (the React remount pattern) leaves the parked
    // node holding its old value forever while the live one really was cleared.
    expect(
      release({ [HANDLE]: { tagName: "INPUT", value: "hello123", isConnected: false } }).result
    ).toEqual({ tracked: false });
  });

  it("reads textContent for a contenteditable and value for a form control", () => {
    // The other half of the inheritance trap: a <textarea>'s textContent is its
    // DEFAULT value, so measuring that would report a cleared field as still full.
    expect(
      release({ [HANDLE]: { tagName: "DIV", textContent: "still here", isConnected: true } }).result
    ).toMatchObject({ tracked: true, length: 10 });
    expect(
      release({
        [HANDLE]: { tagName: "TEXTAREA", value: "ab", textContent: "stale", isConnected: true },
      }).result
    ).toMatchObject({ tracked: true, length: 2 });
  });

  it("still reports residue for a badInput number field reading empty", () => {
    // The box visibly holds what the user typed while `value` reads "", so a
    // length of 0 would let a cancelled clear verify as a success.
    const { result } = release({
      [HANDLE]: { tagName: "INPUT", value: "", isConnected: true, validity: { badInput: true } },
    });
    expect(result.length).toBeGreaterThan(0);
  });

  it("flags a password field so the failure message reports no count", () => {
    expect(
      release({
        [HANDLE]: { tagName: "INPUT", type: "password", value: "s3cret", isConnected: true },
      }).result.secret
    ).toBe(true);
  });

  it("reports untracked rather than a bogus success when the read throws", () => {
    // Treating an unreadable element as empty would turn every such page into a
    // silent clear success.
    const el = { isConnected: true } as Record<string, unknown>;
    Object.defineProperty(el, "tagName", {
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(release({ [HANDLE]: el }).result).toEqual({ tracked: false });
  });
});
