import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import { typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { vegaImpl } from "../src/tools/keyboard/platforms/vega";
import { typeTv } from "../src/tools/keyboard/platforms/tv";
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
//
// `adbExecOutBinary` is mocked separately because the hierarchy dump does NOT
// go through `adbShell`: `adb shell` gives the device no usable controlling
// terminal, so uiautomator's XML never comes back over it (33 bytes of status
// line, exit 0). The dump therefore rides `exec-out` — which returns a Buffer,
// hence the Buffer-shaped mock — and it is a separate call from the `input`
// commands rather than another entry in `adbShell.mock.calls`.
const { adbShell, adbExecOutBinary, isAndroidTv } = vi.hoisted(() => ({
  adbShell: vi.fn(async (_serial: string, _cmd: string, _opts?: unknown): Promise<string> => ""),
  adbExecOutBinary: vi.fn(
    async (_serial: string, _cmd: string, _opts?: unknown): Promise<Buffer> => Buffer.from("")
  ),
  isAndroidTv: vi.fn(async (_serial: string): Promise<boolean> => false),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell,
  adbExecOutBinary,
  isAndroidTv,
}));

// The tvOS probe is what stops an Apple TV udid reaching the HID chord; stub it
// so both sides of that fork are reachable without a booted tvOS simulator.
const { isTvOsSimulator } = vi.hoisted(() => ({
  isTvOsSimulator: vi.fn(async (_udid: string): Promise<boolean> => false),
}));
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator,
}));

import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";
import { makeAndroidImpl } from "../src/tools/keyboard/platforms/android";
import { BLIND_DELETE_COUNT, MAX_DELETE_COUNT } from "../src/utils/android-input";
import { makeIosImpl, makeIosRemoteImpl } from "../src/tools/keyboard/platforms/ios";
import { createKeyboardTool } from "../src/tools/keyboard";

const IOS_SIM: DeviceInfo = { id: "TEST-UDID", platform: "ios", kind: "simulator" };
const CHROMIUM: DeviceInfo = { id: "chromium-cdp-9222", platform: "chromium", kind: "app" };
const VEGA: DeviceInfo = { id: "vega-serial", platform: "vega", kind: "vvd" };
const ANDROID: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };
const APPLE_TV: DeviceInfo = { id: "TV-UDID", platform: "ios", kind: "simulator" };
const IOS_REMOTE: DeviceInfo = { id: "remote-udid", platform: "ios-remote", kind: "simulator" };

// `2>&1` folds the device's stderr into the stream `adbShell` returns: API 30
// writes its usage dump to stderr, and without the redirect that case looks
// exactly like a success. (`Unknown command: …` is the other wording `input`
// uses for a subcommand it does not have, on stdout — see the test for it.)
const SELECT_ALL_CMD = "input keycombination 113 29 2>&1"; // KEYCODE_CTRL_LEFT + KEYCODE_A
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
    // The usages are written out rather than imported from the module under
    // test: 227 is Left GUI and 4 is `a` in the USB HID usage tables, and
    // comparing the recorded traffic against the module's own constants would
    // make any value it declared correct by construction — a wrong one (Cmd+B,
    // RightCtrl+A) selects nothing, the backspace then removes a single
    // character, and the tool still reports `cleared: true`.
    expect(events.slice(0, 4)).toEqual(["Down:227", "Down:4", "Up:4", "Up:227"]);
    // Then the delete that removes the now-selected contents (usage 42).
    expect(events.slice(4, 6)).toEqual(["Down:42", "Up:42"]);
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

    expect(events).toEqual(["Down:227", "Down:4", "Up:4", "Up:227", "Down:42", "Up:42"]);
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

    // Left GUI, `a`, backspace, the typed `a`, enter — HID usages spelled out
    // for the same reason as above.
    const downs = events.filter((e) => e.startsWith("Down:"));
    expect(downs).toEqual(["Down:227", "Down:4", "Down:42", "Down:4", "Down:40"]);
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
    adbExecOutBinary.mockReset();
    adbExecOutBinary.mockImplementation(async () => Buffer.from(""));
    isAndroidTv.mockReset();
    isAndroidTv.mockImplementation(async () => false);
  });

  /** The `input` command lines, in order. The dump is not one of them. */
  const inputCmds = () => adbShell.mock.calls.map((c) => c[1]);
  /** Keycodes of the fallback's single `input keyevent <MOVE_END> <DEL>…` run. */
  const deleteRun = (cmd: string) => {
    expect(cmd.startsWith("input keyevent 123 ")).toBe(true);
    const dels = cmd.split(" ").slice(3);
    expect(dels.every((d) => d === "67")).toBe(true);
    return dels;
  };
  const seedLegacyLevel = () => adbShell.mockImplementationOnce(async () => "Usage: input …");
  const seedDump = (xml: string) =>
    adbExecOutBinary.mockImplementationOnce(async () => Buffer.from(xml));

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

  // uiautomator dump for a focused EditText holding `text`. `password="true"`
  // makes its contents unreadable, which is what forces the blind count.
  const dumpWith = (text: string, password = false) =>
    `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
    `<node index="0" text="${text}" resource-id="email" class="android.widget.EditText" ` +
    `password="${password}" focused="true" bounds="[0,0][100,50]" />` +
    `</hierarchy>`;

  it("falls back to a measured delete run when `keycombination` is unavailable", async () => {
    // An older level has no `keycombination` subcommand — and still EXITS 0,
    // printing a usage dump (to stderr, hence the `2>&1` on the probe). The
    // fallback measures the field instead of guessing: a fixed run would leave
    // a longer field's head in place and append the new text to that residue.
    seedLegacyLevel();
    seedDump(dumpWith("abcdefghij")); // 10 chars

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    const cmds = inputCmds();
    expect(cmds[0]).toBe(SELECT_ALL_CMD);
    // MOVE_END (123) so the caret is past the last character, then one DEL per
    // measured character plus a small margin — all in ONE `input` invocation.
    expect(deleteRun(cmds[1]!)).toHaveLength(10 + 8);
    // The standalone post-select DEL must NOT also fire on this path.
    expect(cmds).not.toContain(DEL_CMD);
  });

  it("reads the hierarchy over exec-out, never over `adb shell`", async () => {
    // `adb shell 'uiautomator dump /dev/tty'` exits 0 and returns only a status
    // line, so a dump read that way measures every field as unreadable and the
    // run silently degrades to the blind count. Pin the transport, not just the
    // resulting number.
    seedLegacyLevel();
    seedDump(dumpWith("abcdefghij"));

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(adbExecOutBinary).toHaveBeenCalledTimes(1);
    expect(adbExecOutBinary.mock.calls[0]![1]).toMatch(/^uiautomator dump /);
    expect(inputCmds().some((c) => c.includes("uiautomator"))).toBe(false);
  });

  it("shares one deadline across the clear's legs instead of a timeout each", async () => {
    // `keyboard` is not `longRunning`, so the MCP adapter abandons the request
    // at 30s. Sizing each leg against 30s independently is what produced a 60s
    // worst case — the client giving up while adb kept deleting on the device.
    // Time spent on an earlier leg has to come off the next one's budget.
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      adbShell.mockImplementationOnce(async () => {
        clock += 3_000; // a slow probe
        return "Usage: input …";
      });
      adbExecOutBinary.mockImplementationOnce(async () => {
        clock += 4_000; // a slow dump
        return Buffer.from(dumpWith("abc"));
      });

      await makeAndroidImpl(registryWith({})).handler(
        {},
        { udid: ANDROID.id, clear: true },
        ANDROID
      );

      const timeoutOf = (call: [string, string, unknown?]) =>
        (call[2] as { timeoutMs: number }).timeoutMs;
      // The dump is a READ leg, so it gets what is left MINUS the reserve held
      // back for the delete run: 20s budget − 3s spent − 11s reserved. Without that subtraction a slow dump can spend the whole
      // budget and the run it measured for then starts with nothing left.
      expect(timeoutOf(adbExecOutBinary.mock.calls[0]!)).toBe(6_000);
      // The delete run is the MUTATING leg, so it gets everything remaining
      // (20s − 7s) rather than a fresh full-size cap — being killed part-way
      // through is what leaves a half-deleted field.
      expect(timeoutOf(adbShell.mock.calls[1]!)).toBe(13_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps the blind delete count under the length limit", () => {
    // The blind run has no measured length, so it can never be refused — if it
    // sat above the limit, every unmeasurable field (every password field on
    // these levels) would be rejected instead of cleared.
    expect(BLIND_DELETE_COUNT).toBeLessThanOrEqual(MAX_DELETE_COUNT);
  });

  it("retries a dump the device refused before falling back to the blind count", async () => {
    // The device serves one UiAutomation connection, so concurrent readers race
    // and the loser gets a bare `Killed` with adb still exiting 0. Degrading
    // straight to the blind count there truncates any field longer than it,
    // while still reporting `cleared: true`.
    seedLegacyLevel();
    seedDump("Killed");
    seedDump(dumpWith("abcdefghij")); // the retry succeeds

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(adbExecOutBinary).toHaveBeenCalledTimes(2);
    expect(deleteRun(inputCmds()[1]!)).toHaveLength(10 + 8);
  });

  it("gives up after one retry rather than dumping forever", async () => {
    seedLegacyLevel();
    seedDump("Killed");
    seedDump("Killed");

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(adbExecOutBinary).toHaveBeenCalledTimes(2);
    expect(deleteRun(inputCmds()[1]!)).toHaveLength(120 + 8);
  });

  it("measures only a FOCUSED editable, ignoring other fields on screen", async () => {
    // Every other fixture marks every node focused, so without this the focus
    // test itself is unpinned: a screen with a longer unfocused EditText would
    // be measured at that field's length — over-deleting, or tripping the
    // length refusal on a clear that works today.
    seedLegacyLevel();
    seedDump(
      `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
        `<node index="0" text="${"u".repeat(120)}" class="android.widget.EditText" password="false" focused="false" />` +
        `<node index="1" text="${"f".repeat(12)}" class="android.widget.EditText" password="false" focused="true" />` +
        `</hierarchy>`
    );

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(12 + 8);
  });

  it("scales the delete run to a long field rather than truncating it", async () => {
    seedLegacyLevel();
    seedDump(dumpWith("x".repeat(140)));

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(140 + 8);
  });

  it("refuses a field too long to delete instead of half-deleting it", async () => {
    // Every DEL is delivered to the app, so a very long field's run overruns the
    // budget mid-way and leaves a partly-deleted value — the corruption this
    // path exists to prevent. Refuse before touching the field instead.
    seedLegacyLevel();
    seedDump(dumpWith("x".repeat(1200)));

    await expect(
      makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID)
    ).rejects.toThrow(/1200 characters.*NOT modified/s);
    // Probe only — no delete run was issued.
    expect(inputCmds()).toEqual([SELECT_ALL_CMD]);
  });

  it("uses the blind count for a password field, whose text is unreadable", async () => {
    // uiautomator reports empty text for password nodes, so a measured 0 would
    // clear nothing at all — the one case where a fixed run is the right answer.
    seedLegacyLevel();
    seedDump(dumpWith("", true));

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(120 + 8);
  });

  it("uses the blind count when the dump itself fails", async () => {
    seedLegacyLevel();
    adbExecOutBinary.mockImplementationOnce(async () => {
      throw new Error("uiautomator dump failed");
    });

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(120 + 8);
  });

  it("uses the blind count when the device refused the dump", async () => {
    // adb exits 0 and uiautomator reports the refusal in-band, so this arrives
    // as a successful call carrying no hierarchy.
    seedLegacyLevel();
    seedDump("ERROR: could not get idle state.");

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(120 + 8);
  });

  it("measures the focused EDITABLE node, not a focused container above it", async () => {
    // A dump carries every window, so more than one node can be `focused` — an
    // IME or overlay contributes its own, and a focused non-text container
    // reports its own `text`.
    //
    // Node order and lengths are chosen so that BOTH rules are load-bearing:
    // the WebView's text is the longest, so dropping the `EditText` filter
    // measures 90 rather than 42; and the short EditText is last in document
    // order, so it is the first one the walk reaches — taking "the first
    // focused match" instead of the longest measures 10. Only filtering to
    // editable nodes AND taking the longest yields 42.
    seedLegacyLevel();
    seedDump(
      `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
        `<node index="0" text="${"y".repeat(42)}" class="android.widget.EditText" password="false" focused="true" />` +
        `<node index="1" text="${"w".repeat(90)}" class="android.webkit.WebView" password="false" focused="true" />` +
        `<node index="2" text="${"z".repeat(10)}" class="android.widget.EditText" password="false" focused="true" />` +
        `</hierarchy>`
    );

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(42 + 8);
  });

  it("treats a focused editable with no `text` attribute as unmeasurable", async () => {
    // Absent is not empty. Reading a missing attribute as 0 would issue only
    // the margin against a field that may be full — the silent half-clear the
    // measurement exists to prevent.
    seedLegacyLevel();
    seedDump(
      `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
        `<node index="0" class="android.widget.EditText" password="false" focused="true" />` +
        `</hierarchy>`
    );

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(120 + 8);
  });

  it("clears a field exactly at the length limit, and refuses one past it", async () => {
    // Pins the boundary itself: without this the limit is only constrained to
    // sit somewhere below the over-length test's value, so it could be lowered
    // to reject fields that work today.
    seedLegacyLevel();
    seedDump(dumpWith("x".repeat(150)));
    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);
    expect(deleteRun(inputCmds()[1]!)).toHaveLength(150 + 8);

    adbShell.mockClear();
    adbExecOutBinary.mockClear();
    seedLegacyLevel();
    seedDump(dumpWith("x".repeat(151)));
    await expect(
      makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID)
    ).rejects.toThrow(/151 characters/);
    expect(inputCmds()).toEqual([SELECT_ALL_CMD]);
  });

  it("measures a field whose text contains a double quote", async () => {
    // uiautomator switches the attribute delimiter to single quotes when the
    // value contains a `"`. A double-quote-only attribute matcher skips the
    // attribute entirely, reads the field as unmeasurable, and degrades to the
    // blind count — which truncates anything longer than it.
    seedLegacyLevel();
    seedDump(
      `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
        `<node index="0" text='say "hi"' class="android.widget.EditText" password="false" focused="true" />` +
        `</hierarchy>`
    );

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(8 + 8); // `say "hi"`
  });

  it("decodes XML entities so the measured length is in real characters", async () => {
    // `&amp;` is five characters in the dump and one on screen; measuring the
    // raw attribute would over-count, which is harmless, but under-counting a
    // decoded entity would not be — pin the decode either way. `&#8230;` covers
    // the numeric references a chained per-entity decoder misses.
    seedLegacyLevel();
    seedDump(dumpWith("a&amp;b&lt;c&#8230;"));

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(6 + 8); // "a&b<c…"
  });

  it("clear+type on a legacy level types only after the delete run", async () => {
    seedLegacyLevel();
    seedDump(dumpWith("old"));

    await makeAndroidImpl(registryWith({})).handler(
      {},
      { udid: ANDROID.id, clear: true, text: "new" },
      ANDROID
    );

    const cmds = inputCmds();
    expect(cmds[0]).toBe(SELECT_ALL_CMD);
    expect(cmds[1]!.startsWith("input keyevent 123 67")).toBe(true);
    expect(cmds[2]).toBe("input text 'new'");
  });

  it("takes the fallback on a level that words the complaint as `Unknown command`", async () => {
    // The other wording `input` uses for a subcommand it does not have. Only the
    // `Usage:` form is exercised elsewhere, so without this the alternative could
    // be dropped from the matcher and `clear` would silently degrade to a
    // one-character backspace on any level that phrases it this way.
    adbShell.mockImplementationOnce(async () => "Unknown command: keycombination");
    seedDump(dumpWith("abc"));

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    const cmds = inputCmds();
    expect(deleteRun(cmds[1]!)).toHaveLength(3 + 8);
    expect(cmds).not.toContain(DEL_CMD);
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

describe("keyboard clear — tool schema", () => {
  // Every real call is dispatched with the PARSED params (`http.ts` and the
  // registry both replace the raw body with `parseResult.data`), and a zod
  // object strips keys it does not declare. So a `clear` missing from the schema
  // is silently dropped on every device while the backends — which the rest of
  // this file calls directly — keep working. Nothing else in the suite crosses
  // the schema, and TypeScript cannot catch it either: `clear` is optional on
  // `KeyboardParams`, so a schema without it still type-checks.
  const tool = createKeyboardTool({ resolveService: vi.fn() } as never);

  it("carries `clear` through the parse the dispatcher actually uses", () => {
    const parsed = tool.zodSchema!.safeParse({ udid: ANDROID.id, text: "abc", clear: true });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ udid: ANDROID.id, text: "abc", clear: true });
  });

  it("accepts `clear` on its own, with no text or key", () => {
    const parsed = tool.zodSchema!.safeParse({ udid: ANDROID.id, clear: true });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ udid: ANDROID.id, clear: true });
  });

  it("rejects a non-boolean `clear` rather than coercing it", () => {
    expect(tool.zodSchema!.safeParse({ udid: ANDROID.id, clear: "yes" }).success).toBe(false);
  });
});

describe("keyboard clear — Chromium (CDP)", () => {
  // The clear runs two different probes: one resolving the focused editable
  // (and parking it on `window`), then one re-reading THAT parked element. The
  // stub answers them separately, keyed off the handle release the second one
  // does, so a test can make the field's before/after states disagree.
  // Defaults describe a clear that worked.
  function recordingApi(
    before: Record<string, unknown> = {
      verdict: "editable",
      label: "INPUT#email",
      length: 8,
      mac: true,
    },
    after: Record<string, unknown> = { tracked: true, length: 0 }
  ) {
    const events: KeyEventArgs[] = [];
    const probes: string[] = [];
    return {
      events,
      probes,
      api: {
        dispatchKeyEvent: async (e: KeyEventArgs) => void events.push(e),
        // Routed by CALL ORDER, not by matching text in the expression: the two
        // probes are always issued resolve-then-release, and keying off a
        // substring of the production source would let a reworded probe keep
        // every test green while answering the wrong one.
        evaluate: async (expression: string) => {
          probes.push(expression);
          return JSON.stringify(probes.length === 1 ? before : after);
        },
      },
    };
  }

  it("issues two DISTINCT probes — resolve, then release", () => {
    // Guards the routing the rest of this block depends on. If both probes were
    // the same expression, every "after" case here would silently be testing the
    // "before" one.
    const { probes, api } = recordingApi();
    return makeChromiumImpl(registryWith(api))
      .handler({}, { udid: CHROMIUM.id, clear: true, delayMs: 0 }, CHROMIUM)
      .then(() => {
        expect(probes).toHaveLength(2);
        expect(probes[0]).not.toBe(probes[1]);
      });
  });

  it("dispatches selectAll+deleteBackward as `commands`, with a real modifier", async () => {
    const { events, api } = recordingApi();

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    const down = events[0]!;
    expect(down.type).toBe("rawKeyDown");
    // THE regression guard: the edit must be named as `commands`. Which
    // modifier reaches Blink's editing layer is build-dependent — on a macOS
    // Chrome 150, Meta+A and Ctrl+A each select ZERO characters, so a delete
    // after one removes a single character while the tool reports success. An
    // implementation that swapped `commands` for `modifiers` fails here.
    expect(down.commands).toEqual(["selectAll", "deleteBackward"]);
    // …and the modifier is set as well. Without it the page receives a bare
    // unmodified `a`, which fires whatever the app binds to that key and lets an
    // app-level preventDefault cancel the clear outright — measured on Chrome
    // 150: the field kept its value and the call still reported success.
    expect(down.modifiers).toBe(4); // Meta — the probe reported a mac renderer
    expect(events.every((e) => e.modifiers === down.modifiers)).toBe(true);
    // `commands` belongs only on the rawKeyDown. Blink honours it on `keyDown`
    // and `char` too, but not `keyUp` — and rawKeyDown is the type a real
    // chord's first event carries, delivering no character of its own.
    expect(events.filter((e) => e.commands !== undefined)).toHaveLength(1);
    expect(result.cleared).toBe(true);
  });

  it("takes the chord's modifier from the RENDERER's platform, not the host's", async () => {
    // The tool-server can reach a renderer running elsewhere — `adb forward` and
    // an SSH tunnel both present as a local CDP port — so the host's own
    // platform is not evidence of which chord that page's users press. The
    // modifier decides which app shortcuts fire, so it has to match the page.
    const { events } = await (async () => {
      const { events, api } = recordingApi({
        verdict: "editable",
        label: "INPUT#email",
        length: 8,
        mac: false,
      });
      await makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, delayMs: 0 },
        CHROMIUM
      );
      return { events };
    })();

    expect(events[0]!.modifiers).toBe(2); // Ctrl
  });

  it("refuses before dispatching when nothing editable has focus", async () => {
    // Blink's selectAll is not scoped to a field: with focus on the body it
    // selects the whole document and the delete no-ops, so the page is left with
    // a document-wide selection and the field untouched — reported as success.
    const { events, api } = recordingApi({ verdict: "none" });

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "new@example.com", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/no editable element has focus/);
    // Nothing dispatched at all — not the clear, and not the text either.
    expect(events).toEqual([]);
  });

  it("refuses when focus is on a non-editable element", async () => {
    const { events, api } = recordingApi({ verdict: "not-editable", label: "BUTTON#submit" });

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/BUTTON#submit/);
    expect(events).toEqual([]);
  });

  it("refuses a readonly field instead of selecting the page around it", async () => {
    // Measured on Chrome 150: the dispatch succeeds against a readonly input,
    // deletes nothing, and leaves the whole field selected. Without this guard
    // the call would fall through to the post-check and be reported as an
    // ineffective clear (a 500) rather than the un-clearable target it is.
    const { events, api } = recordingApi({ verdict: "read-only", label: "INPUT#total" });

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/INPUT#total is read-only/);
    expect(events).toEqual([]);
  });

  it("fails loudly when the field still holds text afterwards", async () => {
    // A page that cancels the keydown, a rich-text editor that cancels the
    // `beforeinput`, or a Chromium too old to know `commands` all produce a
    // successful CDP reply and an unchanged field. Reporting `cleared: true`
    // there is what turns `{ clear, text }` into an append onto the old value.
    const { api } = recordingApi(
      { verdict: "editable", label: "INPUT#email", length: 8 },
      { tracked: true, length: 8 }
    );

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/still holds 8 character\(s\)/);
  });

  it("does not fail on a stale read of a node the page detached", async () => {
    // A page that replaces the field on edit (the React remount pattern) leaves
    // the parked node detached and holding its OLD value, while the live field
    // really was cleared. The release probe reports that as untracked; treating
    // it as residue would fail a clear that worked.
    const { api } = recordingApi(
      { verdict: "editable", label: "INPUT#q", length: 8, mac: true },
      { tracked: false }
    );

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(result.cleared).toBe(true);
  });

  it("stays best-effort when the page refused the parked handle", async () => {
    // A page can pre-define the slot non-writable; the assignment then fails
    // silently and the release probe would read the page's decoy instead of the
    // field. The probe reports the failed park, and nothing is verified against.
    const { api } = recordingApi(
      { verdict: "editable", label: "INPUT#q", length: 8, mac: true, parked: false },
      { tracked: true, length: 8 }
    );

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(result.cleared).toBe(true);
  });

  it("releases the parked element even when the dispatch throws", async () => {
    // The handle is the sole retainer of the node, so a dispatch failure must
    // not leave it pinning a detached subtree on the page.
    const probes: string[] = [];
    const api = {
      dispatchKeyEvent: async () => {
        throw new Error("CDP socket closed");
      },
      evaluate: async (expression: string) => {
        probes.push(expression);
        return JSON.stringify(
          probes.length === 1
            ? { verdict: "editable", label: "INPUT#q", length: 8, mac: true }
            : { tracked: false }
        );
      },
    };

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/CDP socket closed/);
    expect(probes).toHaveLength(2);
  });

  it("does not fail when the field blurred or went away as a result of clearing", async () => {
    // Only positively-observed residue counts as a failure. A page that drops
    // focus once its field empties (or swaps the node out) is reacting to the
    // clear, not ignoring it — failing there would break a working clear.
    const { api } = recordingApi(
      { verdict: "editable", label: "INPUT#q", length: 12 },
      { tracked: true, length: 0 }
    );

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(result.cleared).toBe(true);
  });

  it("stays best-effort when the page cannot be read", async () => {
    // Focus inside a cross-origin iframe, or an `evaluate` that throws. There is
    // nothing to verify against, so refusing would break clears that work today.
    const { events, api } = recordingApi({ verdict: "unknown" });

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(events.map((e) => e.type)).toEqual(["rawKeyDown", "keyUp"]);
    expect(result.cleared).toBe(true);
  });

  it("treats an unreadable page as unknown rather than failing the call", async () => {
    const events: KeyEventArgs[] = [];
    const api = {
      dispatchKeyEvent: async (e: KeyEventArgs) => void events.push(e),
      evaluate: async () => {
        throw new Error("Runtime.evaluate: main world detached");
      },
    };

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(events.map((e) => e.type)).toEqual(["rawKeyDown", "keyUp"]);
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
    // routes a TV target to `typeTv`, and `typeTv` rejects clear. Without it an
    // Android TV serial reaches `typeAndroidPhone` instead — where the chord
    // would in fact go over the wire, since Android TV shares the phone's
    // on-device `input` sink. That is exactly why routing is what has to be
    // pinned: nothing downstream would refuse the call.
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

  it("an Apple TV udid routes clear to the TV rejection, not to the HID chord", async () => {
    // The tvOS mirror of the case above, and the reason the iOS dispatcher is
    // exercised at all: a tvOS sim classifies as platform "ios" by udid shape,
    // so without the `isTvOsSimulator` probe an Apple TV would reach
    // `typeSimulatorServer` and fire Cmd+A at a device whose focus-driven
    // backend cannot use it.
    isTvOsSimulator.mockResolvedValueOnce(true);
    const pressKey = vi.fn();
    const type = vi.fn(async () => {});

    await expect(
      makeIosImpl(registryWith({ pressKey, type })).handler(
        {},
        { udid: APPLE_TV.id, clear: true, text: "hi" },
        APPLE_TV
      )
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(pressKey).not.toHaveBeenCalled();
    expect(type).not.toHaveBeenCalled();
  });

  it("an iPhone udid routes clear to the simulator-server chord", async () => {
    // The other side of the same probe — the routing has to send a non-TV iOS
    // target to the HID transport, or `clear` would be rejected on the platform
    // the tool description says supports it.
    isTvOsSimulator.mockResolvedValueOnce(false);
    const events: string[] = [];
    const pressKey = (direction: "Down" | "Up", keyCode: number) =>
      events.push(`${direction}:${keyCode}`);

    const result = await makeIosImpl(registryWith({ pressKey })).handler(
      {},
      { udid: IOS_SIM.id, clear: true, delayMs: 0 },
      IOS_SIM
    );

    expect(events.slice(0, 4)).toEqual(["Down:227", "Down:4", "Up:4", "Up:227"]);
    expect(result.cleared).toBe(true);
  });

  it("a remote iOS sim clears over the same transport, without a tvOS probe", async () => {
    // `makeIosRemoteImpl` deliberately skips the probe (remote sims are never
    // tvOS, and the probe shells out to local `xcrun`). Nothing else asserts
    // what `clear` does over the sim-remote transport, which the tool
    // description presents as supported without qualification.
    isTvOsSimulator.mockClear();
    const events: string[] = [];
    const pressKey = (direction: "Down" | "Up", keyCode: number) =>
      events.push(`${direction}:${keyCode}`);

    const result = await makeIosRemoteImpl(registryWith({ pressKey })).handler(
      {},
      { udid: IOS_REMOTE.id, clear: true, delayMs: 0 },
      IOS_REMOTE
    );

    expect(events.slice(0, 4)).toEqual(["Down:227", "Down:4", "Up:4", "Up:227"]);
    expect(isTvOsSimulator).not.toHaveBeenCalled();
    expect(result.cleared).toBe(true);
  });
});
