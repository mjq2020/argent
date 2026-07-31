import { FAILURE_CODES, FailureError, type Registry } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../../blueprints/chromium-cdp";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { clearChromiumField } from "../chromium-clear";
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
  if (params.clear) {
    const outcome = await clearChromiumField(api);
    await sleep(delay);
    // Emptying a field routinely moves focus off it — a field that blurs once
    // empty, an app that advances to the next input, a re-render. The keys
    // below are dispatched at the PAGE, not at an element, so they would then
    // land wherever focus went: nowhere at all (the value the caller asked for
    // is simply gone), or appended to a different field. Both were observed on
    // Chrome 150, and both returned the same `{typed, keys, cleared}` a real
    // replacement returns, so the caller could not tell them apart.
    //
    // The clear itself already happened and is not undoable, so this reports
    // the split outcome rather than pretending either half. `keptFocus` is
    // undefined when the page could not be read — that stays best-effort, like
    // the emptiness check.
    if ((descs.length > 0 || named) && outcome.keptFocus === false) {
      throw new FailureError(
        `keyboard: ${outcome.label ?? "the field"} was emptied, but it no longer holds focus ` +
          `afterwards — the page moved focus in response to the clear (a field that blurs when ` +
          `empty, or an app that advances to the next input). Nothing was typed, because the ` +
          `keys would have gone to whatever holds focus now rather than to that field. Tap the ` +
          `field again and type without \`clear\` — it is already empty.`,
        {
          error_code: FAILURE_CODES.KEYBOARD_CLEAR_INEFFECTIVE,
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

  // Key after text: a combined call means "type, then submit" (text +
  // key:"enter"). Pressing the key first submits the still-empty field.
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
