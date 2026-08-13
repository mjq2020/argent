import { FAILURE_CODES, FailureError, type Registry } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../../blueprints/chromium-cdp";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { clearChromiumField, newTargetHandle, releaseParkedTarget } from "../chromium-clear";
import { CHROMIUM_NAMED_KEYS, charToChromiumKey } from "../chromium-keys";
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
  // `\n`, `\r` and `\t` are not characters on this backend: `charToChromiumKey`
  // maps them to the Enter and Tab descriptors, so they are dispatched inside
  // the typing loop as the physical keys they are. They therefore deliver no
  // character to the field and move focus BY DEFINITION — the two reasons the
  // split check below excludes a named `key` — so a `text` carrying one is
  // excluded on the same grounds. Without this the SAME Enter succeeded spelled
  // as `key: "enter"` and failed spelled as `\n`: measured on Chrome 151 against
  // a search box that submits, empties and blurs (the shape the check's own
  // comment cites), `{ clear, text: "query\n" }` raised a 500 naming a split
  // 3/3 while the page had done exactly what was asked, and the control with the
  // named key passed.
  const textMovesFocus = descs.some(({ char }) => char === "\n" || char === "\r" || char === "\t");
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
    // focus move IS the requested effect. `text` carrying `\n`/`\r`/`\t` is
    // excluded for exactly that second reason — see `textMovesFocus`, which is
    // the same physical key arriving by a different spelling. Sampling after the key instead made
    // every `{ clear, text, key: "enter" }` against the ordinary "send and reset"
    // handler — a search box, a chat composer, a tag input, all of which empty
    // the field and blur it on submit — fail with a 500 naming a split that did
    // not happen, on a request that had done exactly what it was asked to. And
    // for characters, focus loss has to be corroborated by the target not holding
    // what was typed — after a clear it should hold exactly those characters, so
    // FEWER means the rest went somewhere else.
    //
    // Strictly fewer, so a page that LENGTHENS what it receives — an input mask
    // inserting separators, an autocompleter — is not read as a split. A page
    // that SHORTENS it is not covered and cannot be: a field that strips
    // characters (`value.replace(/\D/g, "")`), trims whitespace, or truncates at
    // `maxlength`, AND moves focus while the characters are going out, is
    // indistinguishable here from a genuine split — both leave the target
    // holding fewer characters than were dispatched. The message therefore
    // reports what was OBSERVED and names the benign reading, rather than
    // asserting a split as fact; erring toward the report is deliberate, since
    // the alternative is the silent half-written field this parameter exists to
    // prevent (measured on Chrome 150: 8 of 11 runs wrote text outside the
    // target field).
    if (handle && descs.length > 0 && !textMovesFocus) {
      const after = await releaseTarget();
      const landed = after?.length ?? 0;
      if (after?.tracked && after.focused === false && landed < descs.length) {
        // Both halves of the count are credential material: the field's own
        // length when it is a password input, and the REQUEST's length when the
        // text came from a `{{secret:…}}` placeholder — which a plain
        // `type="text"` box takes just as often (an API key, a TOTP code, a
        // password field a show/hide control has toggled to text).
        const missing =
          after.secret || params.secretText
            ? `not all of the text is in it`
            : `only ${landed} of the ${descs.length} character(s) are in it`;
        throw new FailureError(
          `keyboard: the page moved focus away from ${clearedLabel ?? "the field"} while the text ` +
            `was being typed, and ${missing} — so the rest of the value most likely landed ` +
            `wherever focus went. (The other reading: a field that strips or truncates what it ` +
            `receives holds a shorter value legitimately.) Either way this was not a clean ` +
            `replacement — re-read the screen before continuing.`,
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
    handler: async (_services, params, device) => {
      const ref = chromiumCdpRef(device);
      const chromium = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
      return runChromium(chromium, params);
    },
  };
}
