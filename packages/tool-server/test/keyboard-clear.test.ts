import { beforeEach, describe, expect, it, vi } from "vitest";
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
    // `keys` counts what the caller asked to ENTER, so a clear contributes 0 —
    // the same number Android and Chromium report for the same call. Counting
    // the clear's own presses here would make one request report a different
    // `keys` per platform, which is the cross-platform divergence this feature
    // exists to avoid.
    expect(result).toEqual({ typed: "", keys: 0, cleared: true });
  });

  it("reports the same `keys` for a clear as the other backends", async () => {
    const { api } = recordingApi();

    const ios = await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      clear: true,
      text: "abc",
      delayMs: 0,
    });
    const android = await makeAndroidImpl(registryWith({})).handler(
      {},
      { udid: ANDROID.id, clear: true, text: "abc" },
      ANDROID
    );
    const chromium = await makeChromiumImpl(
      registryWith({ dispatchKeyEvent: async () => {} })
    ).handler({}, { udid: CHROMIUM.id, clear: true, text: "abc", delayMs: 0 }, CHROMIUM);

    expect(ios).toEqual({ typed: "abc", keys: 3, cleared: true });
    expect(android).toEqual(ios);
    expect(chromium).toEqual(ios);
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

  it("rejects un-typeable text BEFORE clearing (never destroys the old value)", async () => {
    const { events, api } = recordingApi();

    await expect(
      typeSimulatorServer(registryWith(api), IOS_SIM, {
        udid: IOS_SIM.id,
        clear: true,
        text: "café",
        delayMs: 0,
      })
    ).rejects.toThrow(/No keycode for character "é"/);
    // Clearing and THEN rejecting on character 4 would empty the field, leave
    // "caf" behind, and return 400 — the caller's original value destroyed by a
    // call that failed. Nothing may reach the device.
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
  // `mockReset` (not `mockClear`): several tests queue a one-shot
  // implementation, and a queued entry that goes unconsumed would leak into the
  // next test and fail it somewhere unrelated. Reset drops the queue, then the
  // default "exit 0, no output" behaviour is restored — which is what a device
  // that supports `keycombination` actually returns.
  beforeEach(() => {
    adbShell.mockReset();
    adbShell.mockImplementation(async () => "");
    isAndroidTv.mockReset();
    isAndroidTv.mockImplementation(async () => false);
  });

  it("selects all then deletes, before typing any text", async () => {
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

  it("rejects loudly when `keycombination` is unavailable (API < 30)", async () => {
    // An older API level has no `keycombination` subcommand — and it still
    // EXITS 0: `input` reports the unknown subcommand on stdout and BaseCommand
    // swallows the exception. Measured on-device: `adb shell input bogussubcmd`
    // prints "Unknown command: bogussubcmd" and returns 0. Detecting this by
    // catching a throw would never fire, and the post-select DEL would then
    // delete exactly ONE character while the tool reported `cleared: true`.
    adbShell.mockImplementationOnce(async () => "Unknown command: keycombination");

    await expect(
      makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID)
    ).rejects.toThrow(/needs Android 11 \(API 30\) or newer/);

    // The select-all probe ran; the post-select DEL did NOT. Letting it through
    // is the silent one-character delete this guard exists to stop.
    expect(adbShell.mock.calls.map((c) => c[1])).toEqual([SELECT_ALL_CMD]);
  });

  it("rejects before typing, so clear+type cannot append to the old value", async () => {
    adbShell.mockImplementationOnce(async () => "Unknown command: keycombination");

    await expect(
      makeAndroidImpl(registryWith({})).handler(
        {},
        { udid: ANDROID.id, clear: true, text: "new@example.com" },
        ANDROID
      )
    ).rejects.toThrow(/needs Android 11 \(API 30\) or newer/);
    // No `input text`: otherwise the field would end up
    // "old@example.cnew@example.com" and the call would report success.
    expect(adbShell.mock.calls.map((c) => c[1])).toEqual([SELECT_ALL_CMD]);
  });

  it("does NOT reject when `keycombination` is supported (exit 0, no marker)", async () => {
    // Inverse of the detection: a supported device returns no marker, so the
    // select-all stands and the post-select DEL follows. An over-eager matcher
    // would break `clear` on every modern device.
    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(adbShell.mock.calls.map((c) => c[1])).toEqual([SELECT_ALL_CMD, DEL_CMD]);
  });

  it("surfaces a transport failure on `keycombination` as-is", async () => {
    adbShell.mockImplementationOnce(async () => {
      throw new Error("device offline");
    });

    await expect(
      makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID)
    ).rejects.toThrow(/device offline/);
    // Exactly one adb call — and not misreported as an API-level problem.
    expect(adbShell).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown key before clearing anything", async () => {
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
    // THE regression guard: the clear must be expressed as editing `commands`.
    // A modifier-only Ctrl/Cmd+A never reaches Blink's editing layer — measured
    // on Chrome 150, `modifiers: 2` and `modifiers: 4` each select ZERO
    // characters, so the delete that follows removes exactly one while the tool
    // still reports success. An implementation that swapped `commands` for
    // `modifiers` fails on this line.
    expect(down.commands).toEqual(["selectAll", "deleteBackward"]);
    // Secondary: rules out a hybrid that also sets `modifiers`. Weaker than the
    // line above (which already rejects the broken form), kept because a stray
    // modifier changes what the page's own keydown handlers observe.
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

  it("rejects un-typeable text BEFORE clearing (never destroys the old value)", async () => {
    const dispatchKeyEvent = vi.fn(async () => {});

    await expect(
      makeChromiumImpl(registryWith({ dispatchKeyEvent })).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "café", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/No CDP key descriptor for character "é"/);
    // Same hazard as the iOS case: a clear that lands and then 400s leaves the
    // field holding "caf" instead of its original value.
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

  it("an Android TV target routes clear to the TV rejection, not to adb", async () => {
    // Joins the two halves the other tests check separately: `makeAndroidImpl`
    // routes a TV target to `typeTv`, and `typeTv` rejects clear. Without this,
    // an Android TV serial could reach `typeAndroidPhone` and silently run the
    // select-all chord against a device that cannot use it.
    adbShell.mockClear();
    isAndroidTv.mockResolvedValueOnce(true);

    await expect(
      makeAndroidImpl(registryWith({ type: vi.fn() })).handler(
        {},
        { udid: ANDROID.id, clear: true, text: "hi" },
        ANDROID
      )
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(adbShell).not.toHaveBeenCalled();
  });
});
