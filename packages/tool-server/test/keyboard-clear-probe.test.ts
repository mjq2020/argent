import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  __testing__,
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
// a hand-built `window`/`document` pins them exactly. Same approach the describe
// DOM walker's own test uses against a mock DOM, and it needs no new dependency.

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
  activeElement: FakeEl | null;
  body: FakeEl;
  documentElement: FakeEl;
}

function makeDoc(active: FakeEl | null): FakeDoc {
  const body = { tagName: "BODY" };
  return { activeElement: active, body, documentElement: { tagName: "HTML" } };
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
  // The probe reads `activeElement` through the Document prototype accessor —
  // a page can shadow the document's own named getter with `<form
  // name="activeElement">`. Define it the same way here so that path is real.
  Object.defineProperty(sandbox.Document.prototype, "activeElement", {
    get(this: FakeDoc) {
      return this.activeElement;
    },
    configurable: true,
  });
  Object.assign(sandbox, { globalThis: sandbox });
  const raw = runInNewContext(expression, sandbox) as string;
  return { result: JSON.parse(raw), window };
}

const focused = (el: FakeEl | null, seed?: Record<string, unknown>, platform?: string) =>
  runProbe(__testing__.focusedEditableProbe(HANDLE), makeDoc(el), seed, platform);

describe("chromium clear — focused-element probe", () => {
  it("reports a plain text input as editable, with its length, and parks it", () => {
    const el: FakeEl = { tagName: "INPUT", id: "email", value: "hello123" };
    const { result, window } = focused(el);

    expect(result).toMatchObject({ verdict: "editable", label: "INPUT#email", length: 8 });
    expect(result.parked).toBe(true);
    expect(window[HANDLE]).toBe(el);
  });

  it("reports nothing focused when the body holds focus", () => {
    const doc = makeDoc(null);
    const { result } = runProbe(__testing__.focusedEditableProbe(HANDLE), doc);
    expect(result.verdict).toBe("none");
  });

  it("refuses a button — a focused non-text element is not a clear target", () => {
    const { result, window } = focused({ tagName: "BUTTON", id: "go" });
    expect(result).toMatchObject({ verdict: "not-editable", label: "BUTTON#go" });
    expect(window[HANDLE]).toBeUndefined();
  });

  it.each(["checkbox", "radio", "file", "range", "color", "date", "time", "month", "week"])(
    "refuses <input type=%s>, which holds no editable text",
    (type) => {
      const { result } = focused({ tagName: "INPUT", id: "x", type, value: "" });
      expect(result.verdict).toBe("not-editable");
    }
  );

  it.each(["text", "search", "email", "password", "url", "tel", "number"])(
    "accepts <input type=%s>",
    (type) => {
      const { result } = focused({ tagName: "INPUT", id: "x", type, value: "abcd" });
      expect(result).toMatchObject({ verdict: "editable", length: 4 });
    }
  );

  it("refuses a readonly field rather than dispatching against it", () => {
    const { result } = focused({ tagName: "INPUT", id: "total", value: "42", readOnly: true });
    expect(result).toMatchObject({ verdict: "read-only", label: "INPUT#total" });
  });

  it("classifies a form control inside a contenteditable BY TAG, not by inheritance", () => {
    // `isContentEditable` is inherited, so an <input> inside an editing host
    // reports true. Reading its textContent (always "") would make the
    // verification pass vacuously; a <textarea>'s textContent is its DEFAULT
    // value and never tracks `value`, so a working clear would look like a
    // failure.
    const input = focused({
      tagName: "INPUT",
      id: "i",
      value: "typed value",
      textContent: "",
      isContentEditable: true,
    });
    expect(input.result).toMatchObject({ verdict: "editable", length: 11 });

    const area = focused({
      tagName: "TEXTAREA",
      id: "ta",
      value: "live",
      textContent: "stale default",
      isContentEditable: true,
    });
    expect(area.result).toMatchObject({ verdict: "editable", length: 4 });
  });

  it("treats a number input in badInput as holding content despite an empty value", () => {
    // The box visibly holds what the user typed while `value` reads "", so a
    // length of 0 would let a cancelled clear verify as a success.
    const { result } = focused({
      tagName: "INPUT",
      id: "n",
      type: "number",
      value: "",
      validity: { badInput: true },
    });
    expect(result.verdict).toBe("editable");
    expect(result.length).toBeGreaterThan(0);
  });

  it("descends into an open shadow root and measures the inner field", () => {
    const inner: FakeEl = { tagName: "INPUT", id: "inner", value: "abc" };
    const { result } = focused({
      tagName: "MY-FIELD",
      id: "host",
      shadowRoot: { activeElement: inner },
    });
    expect(result).toMatchObject({ verdict: "editable", label: "INPUT#inner", length: 3 });
  });

  it("descends into a same-origin iframe", () => {
    const inner: FakeEl = { tagName: "TEXTAREA", id: "fi", value: "abcdef" };
    const { result } = focused({ tagName: "IFRAME", id: "f", contentDocument: makeDoc(inner) });
    expect(result).toMatchObject({ verdict: "editable", label: "TEXTAREA#fi", length: 6 });
  });

  it("reports a cross-origin iframe as unknown rather than guessing", () => {
    const { result } = focused({ tagName: "IFRAME", id: "f", contentDocument: null });
    expect(result.verdict).toBe("unknown");
  });

  it("refuses a custom element instead of assuming a closed shadow root", () => {
    // A closed root is indistinguishable from a plain focusable custom element
    // holding nothing editable. Treating the class as "can't tell" made the
    // chord no-op, leave a document-wide selection, and report success.
    const { result, window } = focused({ tagName: "X-THING", id: "z", shadowRoot: null });
    expect(result).toMatchObject({ verdict: "not-editable", label: "X-THING#z" });
    expect(window[HANDLE]).toBeUndefined();
  });

  it("reports the RENDERER's platform so the chord matches the page", () => {
    expect(focused({ tagName: "INPUT", value: "a" }, {}, "MacIntel").result.mac).toBe(true);
    expect(focused({ tagName: "INPUT", value: "a" }, {}, "Win32").result.mac).toBe(false);
    expect(focused({ tagName: "INPUT", value: "a" }, {}, "Linux x86_64").result.mac).toBe(false);
  });

  it("reports a park the page refused, so nothing is verified against a decoy", () => {
    // A page can pre-define the slot non-writable; the assignment then fails
    // silently and the release probe would read the page's object instead.
    const seed: Record<string, unknown> = {};
    Object.defineProperty(seed, HANDLE, {
      value: { tagName: "INPUT", value: "" },
      writable: false,
    });
    const { result } = focused({ tagName: "INPUT", id: "q", value: "hello123" }, seed);
    expect(result.parked).toBe(false);
  });
});

describe("chromium clear — release probe", () => {
  const release = (seed: Record<string, unknown>) =>
    runProbe(__testing__.clearedTargetProbe(HANDLE), makeDoc(null), seed);

  it("reports the parked element's remaining length and releases the slot", () => {
    const { result, window } = release({
      [HANDLE]: { tagName: "INPUT", value: "", isConnected: true },
    });
    expect(result).toEqual({ tracked: true, length: 0 });
    expect(window[HANDLE]).toBeUndefined();
  });

  it("reports residue when the field still holds its value", () => {
    const { result } = release({
      [HANDLE]: { tagName: "INPUT", value: "hello123", isConnected: true },
    });
    expect(result).toEqual({ tracked: true, length: 8 });
  });

  it("reports untracked when nothing was parked", () => {
    expect(release({}).result).toEqual({ tracked: false });
  });

  it("reports untracked for a node the page detached", () => {
    // A field replaced on edit (the React remount pattern) leaves the parked
    // node holding its old value forever while the live one really was cleared.
    const { result } = release({
      [HANDLE]: { tagName: "INPUT", value: "hello123", isConnected: false },
    });
    expect(result).toEqual({ tracked: false });
  });

  it("reads textContent for a contenteditable and value for a form control", () => {
    expect(
      release({ [HANDLE]: { tagName: "DIV", textContent: "still here", isConnected: true } }).result
    ).toEqual({ tracked: true, length: 10 });
    expect(
      release({
        [HANDLE]: { tagName: "TEXTAREA", value: "ab", textContent: "stale", isConnected: true },
      }).result
    ).toEqual({ tracked: true, length: 2 });
  });

  it("still reports residue for a badInput number field reading empty", () => {
    const { result } = release({
      [HANDLE]: {
        tagName: "INPUT",
        value: "",
        isConnected: true,
        validity: { badInput: true },
      },
    });
    expect(result.length).toBeGreaterThan(0);
  });
});
