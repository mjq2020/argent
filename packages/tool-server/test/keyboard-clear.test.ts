import { describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import { typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { vegaImpl } from "../src/tools/keyboard/platforms/vega";
import { typeTv } from "../src/tools/keyboard/platforms/tv";
import { A_KEYCODE, LEFT_GUI_KEYCODE, NAMED_KEYS } from "../src/tools/keyboard/key-codes";
import { UnsupportedOperationError } from "../src/utils/capability";
import type { KeyEventArgs } from "../src/blueprints/chromium-cdp";

vi.mock("../src/utils/vega-input", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/vega-input")>();
  return {
    ...actual,
    injectVegaText: vi.fn(async () => {}),
    injectVegaNamedKey: vi.fn(async () => {}),
  };
});

// Android's clear is observable as the `adb shell input` command sequence.
// `shellQuote` stays real so the asserted strings are the real command lines.
const { adbShell, isAndroidTv } = vi.hoisted(() => ({
  adbShell: vi.fn(async (_serial: string, _cmd: string, _opts?: unknown): Promise<string> => ""),
  isAndroidTv: vi.fn(async (_serial: string): Promise<boolean> => false),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell,
  isAndroidTv,
}));

import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";
import { makeAndroidImpl } from "../src/tools/keyboard/platforms/android";

const IOS_SIM: DeviceInfo = { id: "TEST-UDID", platform: "ios", kind: "simulator" };
const CHROMIUM: DeviceInfo = { id: "chromium-cdp-9222", platform: "chromium", kind: "app" };
const VEGA: DeviceInfo = { id: "vega-serial", platform: "vega", kind: "vvd" };
const ANDROID: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };
const APPLE_TV: DeviceInfo = { id: "TV-UDID", platform: "ios", kind: "simulator" };

const SELECT_ALL_CMD = "input keycombination 113 29"; // KEYCODE_CTRL_LEFT + KEYCODE_A
const DEL_CMD = "input keyevent 67"; // KEYCODE_DEL

function registryWith(api: unknown) {
  return { resolveService: vi.fn(async () => api) } as never;
}

describe("keyboard clear — iOS (simulator-server)", () => {
  // Records the HID traffic as an ordered list so a chord (modifier held across
  // the inner key's down/up) is distinguishable from two separate taps.
  function recordingApi() {
    const events: string[] = [];
    return {
      events,
      api: {
        pressKey: (direction: "Down" | "Up", keyCode: number) =>
          events.push(`${direction}:${keyCode}`),
      },
    };
  }

  it("holds Cmd across A, then presses backspace, before typing any text", async () => {
    const { events, api } = recordingApi();

    const result = await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      clear: true,
      text: "a",
      delayMs: 0,
    });

    // Cmd must go down before A and come up after it — a chord, not two taps.
    expect(events.slice(0, 4)).toEqual([
      `Down:${LEFT_GUI_KEYCODE}`,
      `Down:${A_KEYCODE}`,
      `Up:${A_KEYCODE}`,
      `Up:${LEFT_GUI_KEYCODE}`,
    ]);
    // Then the delete that removes the now-selected contents…
    expect(events.slice(4, 6)).toEqual([
      `Down:${NAMED_KEYS.backspace}`,
      `Up:${NAMED_KEYS.backspace}`,
    ]);
    // …and only then the text. Clear-after-text would empty the field the tool
    // just populated, so the ordering is the whole contract.
    expect(events.slice(6)).toEqual(["Down:4", "Up:4"]);
    expect(result.cleared).toBe(true);
  });

  it("clears with no text and reports cleared", async () => {
    const { events, api } = recordingApi();

    const result = await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      clear: true,
      delayMs: 0,
    });

    expect(events).toEqual([
      `Down:${LEFT_GUI_KEYCODE}`,
      `Down:${A_KEYCODE}`,
      `Up:${A_KEYCODE}`,
      `Up:${LEFT_GUI_KEYCODE}`,
      `Down:${NAMED_KEYS.backspace}`,
      `Up:${NAMED_KEYS.backspace}`,
    ]);
    expect(result).toEqual({ typed: "", keys: 2, cleared: true });
  });

  it("orders clear → text → key in a single call", async () => {
    const { events, api } = recordingApi();

    await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      clear: true,
      text: "a",
      key: "enter",
      delayMs: 0,
    });

    const downs = events.filter((e) => e.startsWith("Down:"));
    expect(downs).toEqual([
      `Down:${LEFT_GUI_KEYCODE}`,
      `Down:${A_KEYCODE}`,
      `Down:${NAMED_KEYS.backspace}`,
      "Down:4",
      `Down:${NAMED_KEYS.enter}`,
    ]);
  });

  it("rejects an unknown key before clearing anything", async () => {
    const { events, api } = recordingApi();

    await expect(
      typeSimulatorServer(registryWith(api), IOS_SIM, {
        udid: IOS_SIM.id,
        clear: true,
        key: "bogus",
        delayMs: 0,
      })
    ).rejects.toThrow(/Unknown key "bogus"/);
    expect(events).toEqual([]);
  });

  it("omits `cleared` entirely when clear was not requested", async () => {
    const { api } = recordingApi();

    const result = await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      text: "a",
      delayMs: 0,
    });

    expect(result).not.toHaveProperty("cleared");
  });

  it("still types a capital with shift (the modifier generalisation is not a regression)", async () => {
    const { events, api } = recordingApi();

    await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      text: "A",
      delayMs: 0,
    });

    // 225 is SHIFT_KEYCODE — held across A's down/up, and NOT the Cmd keycode.
    expect(events).toEqual(["Down:225", "Down:4", "Up:4", "Up:225"]);
  });
});

describe("keyboard clear — Android (adb input)", () => {
  it("selects all then deletes, before typing any text", async () => {
    adbShell.mockClear();

    const result = await makeAndroidImpl(registryWith({})).handler(
      {},
      { udid: ANDROID.id, clear: true, text: "abc" },
      ANDROID
    );

    expect(adbShell.mock.calls.map((c) => c[1])).toEqual([
      SELECT_ALL_CMD,
      DEL_CMD,
      "input text 'abc'",
    ]);
    expect(result.cleared).toBe(true);
  });

  it("orders clear → text → key in a single call", async () => {
    adbShell.mockClear();

    await makeAndroidImpl(registryWith({})).handler(
      {},
      { udid: ANDROID.id, clear: true, text: "abc", key: "enter" },
      ANDROID
    );

    expect(adbShell.mock.calls.map((c) => c[1])).toEqual([
      SELECT_ALL_CMD,
      DEL_CMD,
      "input text 'abc'",
      "input keyevent 66",
    ]);
  });

  it("falls back to MOVE_END + repeated DEL when `keycombination` is unavailable", async () => {
    adbShell.mockClear();
    // An older API level has no `keycombination` subcommand: `input` exits
    // non-zero and runAdb rewraps that as a throw.
    adbShell.mockImplementationOnce(async () => {
      throw new Error("Unknown command: keycombination");
    });

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    const cmds = adbShell.mock.calls.map((c) => c[1]);
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toBe(SELECT_ALL_CMD);
    // MOVE_END (123) first so the caret is past the last character, then a run
    // of DELs backspacing over the contents — all in ONE `input` invocation.
    expect(cmds[1]).toMatch(/^input keyevent 123( 67)+$/);
    // The fallback must not also fire the standalone post-select DEL: that
    // would delete one character beyond the field on a partially-filled clear.
    expect(cmds).not.toContain(DEL_CMD);
  });

  it("propagates a failure of the fallback itself (no silent partial clear)", async () => {
    adbShell.mockClear();
    adbShell.mockImplementationOnce(async () => {
      throw new Error("Unknown command: keycombination");
    });
    adbShell.mockImplementationOnce(async () => {
      throw new Error("device offline");
    });

    await expect(
      makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID)
    ).rejects.toThrow(/device offline/);
  });

  it("rejects an unknown key before clearing anything", async () => {
    adbShell.mockClear();

    await expect(
      makeAndroidImpl(registryWith({})).handler(
        {},
        { udid: ANDROID.id, clear: true, key: "bogus" },
        ANDROID
      )
    ).rejects.toThrow(/Unknown key "bogus"/);
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("rejects un-typeable text before clearing anything", async () => {
    adbShell.mockClear();

    await expect(
      makeAndroidImpl(registryWith({})).handler(
        {},
        { udid: ANDROID.id, clear: true, text: "café" },
        ANDROID
      )
    ).rejects.toThrow();
    // A clear that lands and *then* 400s would leave the field emptied with
    // nothing typed — worse than the original value.
    expect(adbShell).not.toHaveBeenCalled();
  });
});

describe("keyboard clear — Chromium (CDP)", () => {
  function recordingApi() {
    const events: KeyEventArgs[] = [];
    return { events, api: { dispatchKeyEvent: async (e: KeyEventArgs) => void events.push(e) } };
  }

  it("dispatches selectAll+deleteBackward as `commands`, never as `modifiers`", async () => {
    const { events, api } = recordingApi();

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    const down = events[0];
    expect(down.type).toBe("rawKeyDown");
    expect(down.commands).toEqual(["selectAll", "deleteBackward"]);
    // THE regression guard. A modifier-only Ctrl/Cmd+A never reaches Blink's
    // editing layer: it selects zero characters, so the delete that follows
    // removes exactly ONE character while the tool still reports success —
    // a different wrong value per platform in a cross-platform flow.
    expect(down.modifiers).toBeUndefined();
    expect(events.every((e) => e.modifiers === undefined)).toBe(true);
    expect(result.cleared).toBe(true);
  });

  it("pairs the rawKeyDown with a keyUp and nothing else when text is absent", async () => {
    const { events, api } = recordingApi();

    await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(events.map((e) => e.type)).toEqual(["rawKeyDown", "keyUp"]);
  });

  it("orders clear → text → key in a single call", async () => {
    const { events, api } = recordingApi();

    await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, text: "hi", key: "enter", delayMs: 0 },
      CHROMIUM
    );

    // The clear's rawKeyDown, then each character, then Enter.
    expect(events.filter((e) => e.type === "rawKeyDown").length).toBe(1);
    const typedOrder = events
      .filter((e) => e.type === "rawKeyDown" || e.type === "keyDown")
      .map((e) => e.key);
    expect(typedOrder).toEqual(["a", "h", "i", "Enter"]);
  });

  it("rejects an unknown key before clearing anything", async () => {
    const dispatchKeyEvent = vi.fn(async () => {});

    await expect(
      makeChromiumImpl(registryWith({ dispatchKeyEvent })).handler(
        {},
        { udid: CHROMIUM.id, clear: true, key: "bogus", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/Unknown key "bogus"/);
    expect(dispatchKeyEvent).not.toHaveBeenCalled();
  });

  // The blueprint half of this guarantee — that `commands` actually survives
  // the payload builder on the way to `Input.dispatchKeyEvent` — is pinned in
  // chromium-cdp-blueprint.test.ts against a fake CDP server.
});

describe("keyboard clear — unsupported platforms", () => {
  it("vega rejects clear with no injection attempted", async () => {
    vi.mocked(injectVegaText).mockClear();
    vi.mocked(injectVegaNamedKey).mockClear();

    await expect(
      vegaImpl.handler({}, { udid: VEGA.id, clear: true, text: "hi" }, VEGA)
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    // A silent no-op here is exactly the #449 failure mode: the caller believes
    // the field was emptied and the new text replaced the old.
    expect(injectVegaText).not.toHaveBeenCalled();
    expect(injectVegaNamedKey).not.toHaveBeenCalled();
  });

  it("vega still types normally when clear is absent", async () => {
    vi.mocked(injectVegaText).mockClear();

    await vegaImpl.handler({}, { udid: VEGA.id, text: "hi" }, VEGA);

    expect(injectVegaText).toHaveBeenCalledWith("hi");
  });

  it("tv rejects clear with no typing attempted", async () => {
    const type = vi.fn(async () => {});

    await expect(
      typeTv(registryWith({ type }), APPLE_TV, { udid: APPLE_TV.id, clear: true, text: "hi" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(type).not.toHaveBeenCalled();
  });

  it("tv still types normally when clear is absent", async () => {
    const type = vi.fn(async () => {});

    const result = await typeTv(registryWith({ type }), APPLE_TV, {
      udid: APPLE_TV.id,
      text: "hi",
    });

    expect(type).toHaveBeenCalledWith("hi");
    expect(result).toEqual({ typed: "hi", keys: 2 });
  });
});
