import { FAILURE_CODES, FailureError, type Registry } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../../blueprints/chromium-cdp";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { clearChromiumField, newTargetHandle, releaseParkedTarget } from "../chromium-clear";
import { CHROMIUM_NAMED_KEYS, charToChromiumKey } from "../chromium-keys";
import { deviceChainKey, serializePerDevice } from "../device-chain";
import type { KeyboardParams, KeyboardResult } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runChromium(api: ChromiumCdpApi, params: KeyboardParams): Promise<KeyboardResult> {
  const delay = params.delayMs ?? 50;
  let keysPressed = 0;

  // Resolve the named key BEFORE anything is dispatched: an unknown name has to
  // fail fast rather than after the text has already been typed, and `clear`
  // empties the field, so it must reject with the field still intact rather than
  // emptied and then 400.
  let named: (typeof CHROMIUM_NAMED_KEYS)[string] | undefined;
  if (params.key) {
    const lower = params.key.toLowerCase();
    // Own-property check: a prototype key like "constructor" would otherwise
    // pass the falsy guard with a garbage value and dispatch a broken CDP key
    // event instead of rejecting as an unknown key.
    named = Object.hasOwn(CHROMIUM_NAMED_KEYS, lower) ? CHROMIUM_NAMED_KEYS[lower] : undefined;
    if (!named) {
      // Well-typed but unusable input (`key` is a free string) — a caller
      // mistake mapped to 400 (matching the Android path, uniform across
      // backends), keeping the KEYBOARD_KEY_UNSUPPORTED telemetry code (#420).
      throw new InvalidToolInputError(
        `Unknown key "${params.key}". Supported: ${Object.keys(CHROMIUM_NAMED_KEYS).join(", ")}`,
        {
          error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
          failure_stage: "keyboard_named_key_chromium",
          error_kind: "unsupported",
        }
      );
    }
  }

  // Resolve EVERY character before touching the page: no device write happens
  // until the whole request is known to be executable. Resolving per character
  // inside the loop below would let a `{ clear, text }` whose character 4 has no
  // CDP descriptor destroy the field's original value and leave a fragment
  // behind, so a call that returned 400 would leave the caller worse off than
  // before it. Same up-front-validation rule the android backend applies with
  // `assertTypeableAndroidText`.
  const descs = params.text
    ? [...params.text].map((char) => ({ char, desc: charToChromiumKey(char) }))
    : [];
  // How many characters the split check below can hold the field to: the ones
  // before the first `\n`, `\r` or `\t`, or all of them when `text` carries
  // none.
  //
  // Those three are not characters on this backend: `charToChromiumKey` maps
  // them to the Enter and Tab descriptors, so they are dispatched inside the
  // typing loop as the physical keys they are, and they can move focus BY
  // DEFINITION — the reason the split check also excludes a named `key`.
  // Anything sent AFTER one of them may therefore land in a different field
  // because the request asked for exactly that, which is why the guarantee stops
  // there. Without that stop the SAME Enter succeeded spelled as `key: "enter"`
  // and failed spelled as `\n`: measured on Chrome 151 against a search box that
  // submits, empties and blurs (the shape the check's own comment cites),
  // `{ clear, text: "query\n" }` raised a 500 naming a split 3/3 while the page
  // had done exactly what was asked, and the control with the named key passed.
  //
  // What it no longer does is drop the check for the WHOLE call. `descs.some`
  // tested the whole string and skipped every character, so one newline in a
  // `<textarea>` — where a newline is ordinary content that moves nothing —
  // switched the guarantee off for a value of any length. Measured on Chrome 151
  // against an exact control pair differing only by one `\n`, in a textarea
  // whose 4th `input` moves focus to a neighbour: `{ clear, text: "aaaabbbb" }`
  // correctly reported the split, `{ clear, text: "aaaa\nbbbb" }` returned
  // `cleared: true`, and both left the same `["aaa", "abbbb"]` behind.
  //
  // Counting the PREFIX keeps both: the search box delivers all 5 of `query`
  // before its Enter and still passes, while the textarea delivers 3 of the
  // first 4 and fails. It cannot see a split that happens after the Enter, which
  // is the part no evidence here can separate from the focus move the caller
  // asked for.
  const firstMovesFocus = descs.findIndex(
    ({ char }) => char === "\n" || char === "\r" || char === "\t"
  );
  const guaranteed = firstMovesFocus < 0 ? descs.length : firstMovesFocus;
  for (const { char, desc } of descs) {
    if (!desc) {
      // A character with no CDP descriptor can't be typed — caller input error
      // → 400, keeping the KEYBOARD_CHARACTER_UNSUPPORTED telemetry code (#420).
      throw new InvalidToolInputError(`No CDP key descriptor for character "${char}"`, {
        error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
        failure_stage: "keyboard_char_chromium",
        error_kind: "unsupported",
      });
    }
  }

  // Clear before text. `clearChromiumField` refuses up front if nothing
  // editable holds focus, and throws when it OBSERVES the value survive — so
  // reaching the typing loop means the field was either seen empty or could not
  // be read at all (a cross-origin iframe, a detached node). It never means the
  // field was seen to still hold its value.
  //
  // The handle is owned here, not inside the clear, because the parked element
  // has to outlive the typing: focus is asked about twice, once immediately
  // before the first character and once after the last, and the `finally`
  // guarantees the element is let go either way.
  const handle = params.clear ? newTargetHandle() : undefined;
  const typing = descs.length > 0 || named !== undefined;
  let released = false;
  let clearedLabel: string | undefined;
  // Whether the clear saw a password field. The split message below applies the
  // same withhold-the-count rule, and the read it can see is the LATER one — a
  // show/hide control that switches the field to `type="text"` while the
  // characters go out reports a plain box there.
  let clearedSecret = false;
  const releaseTarget = async () => {
    released = true;
    return releaseParkedTarget(api, handle!);
  };

  try {
    if (handle) {
      // The clear settles between its key dispatch and its read-back, so the
      // focus answer is the last thing before the loop below. `delay` is passed
      // only as a FLOOR on that settle — a caller asking for a slower cadence
      // gets a longer wait, but a fast one cannot shrink the window the verdict
      // rests on (see CLEAR_SETTLE_MS).
      const outcome = await clearChromiumField(api, handle, delay, params.secretText === true);
      clearedLabel = outcome.label;
      clearedSecret = outcome.secret === true;
      // Emptying a field routinely moves focus off it — a field that blurs once
      // empty, an app that advances to the next input, a re-render. The keys
      // below are dispatched at the PAGE, not at an element, so they would then
      // land wherever focus went: nowhere at all (the value the caller asked
      // for is simply gone), or appended to a different field. Both were
      // observed on Chrome 150, and both returned the same
      // `{typed, keys, cleared}` a real replacement returns, so the caller
      // could not tell them apart.
      //
      // The clear itself already happened and is not undoable, so this reports
      // the split outcome rather than pretending either half. `keptFocus` is
      // undefined when the page could not be read — that stays best-effort,
      // like the emptiness check.
      if (typing && outcome.keptFocus === false) {
        throw new FailureError(
          `keyboard: ${outcome.label ?? "the field"} was emptied, but it no longer holds focus ` +
            `afterwards — the page moved focus in response to the clear (a field that blurs when ` +
            `empty, or an app that advances to the next input). Nothing was typed and no key was ` +
            `pressed, because either would have gone to whatever holds focus now rather than to ` +
            `that field. Tap the field again and send the rest of the request without \`clear\` — ` +
            `the field is already empty.`,
          {
            // Its own code, not INEFFECTIVE: the field WAS emptied here, and
            // INEFFECTIVE means it was not. A client keying on the signal has
            // to tell "re-clear required" from "the field is already empty,
            // send the rest without `clear`" — and `failure_stage`, the only
            // thing that separated them, never reaches the wire (`http.ts`
            // serializes `error_code` and `error_kind` only).
            error_code: FAILURE_CODES.KEYBOARD_CLEAR_FOCUS_LOST,
            failure_stage: "keyboard_clear_focus_lost_chromium",
            failure_area: "tool_server",
            error_kind: "unsupported",
          }
        );
      }
    }

    for (const { desc } of descs) {
      await api.dispatchKeyEvent({
        type: "keyDown",
        key: desc!.key,
        code: desc!.code,
        windowsVirtualKeyCode: desc!.windowsVirtualKeyCode,
      });
      // `char` delivers the actual codepoint to the focused input; without
      // this the field receives no value.
      await api.dispatchKeyEvent({ type: "char", text: desc!.text });
      await api.dispatchKeyEvent({
        type: "keyUp",
        key: desc!.key,
        code: desc!.code,
        windowsVirtualKeyCode: desc!.windowsVirtualKeyCode,
      });
      keysPressed++;
      await sleep(delay);
    }

    // One sample before the loop cannot cover a blur that lands DURING it: the
    // characters go out `delay` apart, so a page that moves focus part-way
    // through splits the value across two fields. Measured on Chrome 150, where
    // a field blurring 300ms after emptying left `us` in the target and
    // `er@example.comOTHER-FIELD` in its neighbour, reported as a clean
    // replacement. Asking the same parked element again is what turns that into
    // a failure the caller can see; it also releases the element.
    //
    // Focus loss ALONE is not that evidence, and treating it as such made this
    // fire on requests where every character landed where it was asked to.
    // Measured on Chrome 150, all reproduced 4-5/5:
    //
    //   - `{ clear, text }` on a field that advances focus once its value is
    //     complete (the OTP / card-number pattern) — the whole value in the
    //     target, the neighbour empty, and a "split across fields" 500;
    //   - `{ clear, key: "tab" }` — Tab moves focus BY DEFINITION and dispatches
    //     no character at all, so this combination could never succeed;
    //   - `{ clear, key: "enter" }` on a search box that blurs on submit — the
    //     ordinary "replace the query and submit" shape.
    //
    // So the check is narrowed on both axes. A named `key` never reaches it: the
    // sample is taken HERE, between the last character and the key, because one
    // key event cannot be split across two fields while for `tab`/`enter` the
    // focus move IS the requested effect. `text` carrying `\n`/`\r`/`\t` ends the
    // guarantee at that character for exactly that second reason — see
    // `guaranteed`, which is the same physical key arriving by a different
    // spelling, and everything before it is still held to. Sampling after the
    // key instead made every `{ clear, text, key: "enter" }` against the ordinary
    // "send and reset" handler — a search box, a chat composer, a tag input, all
    // of which empty the field and blur it on submit — fail with a 500 naming a
    // split that did not happen, on a request that had done exactly what it was
    // asked to.
    //
    // For characters the evidence is PROVENANCE, corroborated by the value:
    // `delivered` counts the insertions the parked element itself received, and
    // the failure needs both a shortfall there and a value that is wrong. A
    // single focus sample was neither necessary nor sufficient, and each half of
    // the old rule was defeated by an ordinary page (both measured on Chrome 151,
    // 3/3, both reported as a clean `cleared: true` replacement):
    //
    //   - focus that LEAVES and COMES BACK. The sample was taken after the last
    //     character, so a loss that did not persist to that instant was
    //     invisible: an autosuggest-shaped handler left `aefgh` in the target and
    //     `bcd` in the neighbour with focus restored.
    //   - a field that REVERTS on blur (an editable data grid, a click-to-edit
    //     title, a controlled input rejecting a value). It ends up holding MORE
    //     characters than were sent, so "fewer than dispatched" could not fire —
    //     while holding its exact pre-clear value, which makes `cleared` flatly
    //     false. Hence `reverted` as the second way for the value to be wrong.
    //
    // Requiring both signals is what keeps the benign shapes out. A page that
    // NORMALISES what it receives — stripping separators
    // (`value.replace(/\D/g, "")`), trimming, upper-casing — holds a shorter
    // value legitimately, and every character was still delivered to it, so it no
    // longer fires (it did before, and could not be separated from a split by the
    // count alone). A page that LENGTHENS it (an input mask, an autocompleter)
    // was already excluded and still is. Conversely a page that hides the
    // deliveries by calling `stopPropagation` on `beforeinput` is saved by the
    // value half, since the characters it swallowed the events for are in the
    // field.
    if (handle && guaranteed > 0) {
      const after = await releaseTarget();
      const landed = after?.length ?? 0;
      // -1 means the count could not be read at all, so fall back to the focus
      // sample rather than inventing evidence either way.
      //
      // That fallback is what still excludes the WHOLE call when `text` carries
      // an Enter or a Tab: a focus sample cannot tell "the page split the value"
      // from "the Enter I was asked to send submitted the form and blurred the
      // field", which is the false positive this exclusion was added for. The
      // prefix rule replaces it only where there is provenance to replace it
      // with — a readable delivery count, which says how many characters reached
      // the parked element regardless of what the Enter then did.
      const delivered =
        after?.delivered !== undefined && after.delivered >= 0 ? after.delivered : undefined;
      const shortDelivery =
        delivered !== undefined
          ? delivered < guaranteed
          : guaranteed === descs.length && after?.focused === false;
      // A field at its own `maxlength` is the standing exclusion, and the one the
      // OTP note above got wrong: the pattern it was measured against is the
      // SINGLE-field variant, where the whole value fits. A SEGMENTED one — six
      // `<input maxlength="1">` boxes with the standard auto-advance handler,
      // which is how essentially every 2FA code, PIN and split card number is
      // built — holds 1 of N BY DESIGN, and receives 1 delivery of N as well, so
      // neither signal can tell it from a split. A field that cannot hold another
      // character explains its own short value.
      const valueWrong = landed < guaranteed || after?.reverted === true;
      if (after?.tracked && shortDelivery && valueWrong && !after.full) {
        // Both halves of the count are credential material: the field's own
        // length when it is a password input, and the REQUEST's length when the
        // text came from a `{{secret:…}}` placeholder — which a plain
        // `type="text"` box takes just as often (an API key, a TOTP code, a
        // password field a show/hide control has toggled to text).
        // Counted against what was checked, not against what was sent: with an
        // Enter or a Tab in `text` those differ, and quoting the request's own
        // length there would name characters this never had an opinion about.
        const upTo =
          guaranteed < descs.length
            ? ` before the first Enter/Tab of the ${descs.length} sent`
            : ``;
        const reached =
          after.secret || clearedSecret || params.secretText
            ? `not all of the text reached`
            : `only ${delivered ?? landed} of the ${guaranteed} character(s)${upTo} reached`;
        // The revert is worth its own sentence: it is the state in which
        // `cleared` would have been flatly false.
        const holds = after.reverted
          ? ` That field now holds the value it held BEFORE the clear, so it was not replaced at all.`
          : ``;
        throw new FailureError(
          `keyboard: ${reached} ${clearedLabel ?? "the field"} — the page moved focus away from it ` +
            `while the text was being typed, so the rest of the value most likely landed wherever ` +
            `focus went.${holds} This was not a clean replacement — re-read the screen before ` +
            `continuing.`,
          {
            // Same reason as the sibling above: the clear itself worked, and
            // what failed is where the characters went.
            error_code: FAILURE_CODES.KEYBOARD_CLEAR_FOCUS_LOST,
            failure_stage: "keyboard_clear_focus_lost_typing_chromium",
            failure_area: "tool_server",
            error_kind: "unsupported",
          }
        );
      }
    }

    // Key after text: a combined call means "type, then press" (text +
    // key:"enter"). Pressing the key first would send the still-empty field.
    if (named) {
      await api.dispatchKeyEvent({
        type: "keyDown",
        key: named.key,
        code: named.code,
        windowsVirtualKeyCode: named.windowsVirtualKeyCode,
      });
      await sleep(delay);
      await api.dispatchKeyEvent({
        type: "keyUp",
        key: named.key,
        code: named.code,
        windowsVirtualKeyCode: named.windowsVirtualKeyCode,
      });
      keysPressed++;
    }
  } finally {
    // Never leave the slot behind: it is the sole retainer of the parked node,
    // and a per-call name means a leaked one is never overwritten by the next
    // clear.
    if (handle && !released) await releaseTarget().catch(() => undefined);
  }

  return {
    typed: params.text ?? params.key ?? "",
    keys: keysPressed,
    ...(params.clear ? { cleared: true } : {}),
  };
}

export function makeChromiumImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device, options) => {
      const ref = chromiumCdpRef(device);
      const chromium = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
      // Serialized per device, because a run holds the parked element and the
      // emptied field across many CDP round trips — the clear, the settle, the
      // read-back, then one dispatch per character. A concurrent run types into
      // that window and both calls report a clean replacement: measured on this
      // branch, two `{ clear, text }` calls of `AAAA` and `BBBB` at 0ms left
      // `ABABABAB` in the field with both returning `cleared: true` and their
      // own four characters as `typed`. See `serializePerDevice`.
      //
      // The service is resolved BEFORE the queue, so a device whose CDP session
      // has to be established does not hold the chain while it connects.
      return serializePerDevice(deviceChainKey(device.id), () => {
        // Checked HERE, as this call's turn comes round, so a request the client
        // has already abandoned does not spend the device's keyboard.
        options?.signal?.throwIfAborted();
        return runChromium(chromium, params);
      });
    },
  };
}
