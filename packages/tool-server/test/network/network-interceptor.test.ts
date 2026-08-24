import { runInNewContext } from "node:vm";
import { describe, it, expect } from "vitest";
import {
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkLogReadScript,
  makeNetworkDetailReadScript,
} from "../../src/utils/debugger/scripts/network-interceptor";

describe("NETWORK_INTERCEPTOR_SCRIPT", () => {
  async function interceptResponse({
    body,
    mimeType,
    contentLength,
    textEncoder = TextEncoder,
  }: {
    body: string | undefined;
    mimeType: string;
    contentLength?: number;
    textEncoder?: typeof TextEncoder | undefined;
  }) {
    const response = {
      url: "https://example.test/data",
      status: 200,
      statusText: "OK",
      headers: {
        forEach: (callback: (value: string, key: string) => void) => {
          callback(mimeType, "content-type");
          if (contentLength !== undefined) callback(String(contentLength), "content-length");
        },
      },
      clone: () => ({ text: async () => body }),
    };
    const sandbox: Record<string, unknown> = {
      TextEncoder: textEncoder,
      fetch: async () => response,
    };

    runInNewContext(NETWORK_INTERCEPTOR_SCRIPT, sandbox);
    await (sandbox.fetch as () => Promise<unknown>)();
    await Promise.resolve();

    return (sandbox.__argent_network_log as Array<{ encodedDataLength: number }>)[0];
  }

  it.each([
    ["TextEncoder", TextEncoder],
    ["the legacy fallback", undefined],
  ])("records UTF-8 response bytes with %s", async (_label, textEncoder) => {
    const body = JSON.stringify({ message: "你好 👋" });
    const entry = await interceptResponse({ body, mimeType: "application/json", textEncoder });

    expect(entry?.encodedDataLength).toBe(Buffer.byteLength(body, "utf8"));
    expect(entry?.encodedDataLength).not.toBe(body.length);
  });

  it("does not re-encode replacement characters from a binary response", async () => {
    const body = "\uFFFD".repeat(512) + "a".repeat(512);
    const entry = await interceptResponse({ body, mimeType: "application/octet-stream" });

    expect(entry?.encodedDataLength).toBe(1024);
    expect(entry?.encodedDataLength).not.toBe(Buffer.byteLength(body, "utf8"));
  });

  it("prefers a valid Content-Length for binary responses", async () => {
    const entry = await interceptResponse({
      body: undefined,
      mimeType: "image/png",
      contentLength: 16,
    });

    expect(entry?.encodedDataLength).toBe(16);
  });

  it("records zero when a binary body is unavailable", async () => {
    const entry = await interceptResponse({ body: undefined, mimeType: "image/png" });

    expect(entry?.encodedDataLength).toBe(0);
  });
});

describe("makeNetworkLogReadScript", () => {
  it("returns a string containing the start and limit values", () => {
    const script = makeNetworkLogReadScript(10, 50, 8081);
    expect(script).toContain("var start = 10");
    expect(script).toContain("var limit = 50");
  });

  it("embeds the metro port for filtering", () => {
    const script = makeNetworkLogReadScript(0, 50, 8081);
    expect(script).toContain("localhost:8081");
    expect(script).toContain("127.0.0.1:8081");
  });

  it("uses different metro port values correctly", () => {
    const script3000 = makeNetworkLogReadScript(0, 50, 3000);
    expect(script3000).toContain("localhost:3000");
    expect(script3000).toContain("127.0.0.1:3000");
    expect(script3000).not.toContain("localhost:8081");
  });

  it("reads from __argent_network_log", () => {
    const script = makeNetworkLogReadScript(0, 50, 8081);
    expect(script).toContain("globalThis.__argent_network_log");
  });

  it("returns interceptorInstalled: false when no log exists", () => {
    const script = makeNetworkLogReadScript(0, 50, 8081);
    expect(script).toContain("interceptorInstalled: false");
  });

  it("strips responseBody from list view entries", () => {
    const script = makeNetworkLogReadScript(0, 50, 8081);
    // The script builds entries without responseBody to avoid large payloads
    expect(script).not.toContain("responseBody: s.responseBody");
  });

  it("is a valid IIFE", () => {
    const script = makeNetworkLogReadScript(0, 50, 8081);
    expect(script.trim()).toMatch(/^\(function\(\)/);
    expect(script.trim()).toMatch(/\)\(\)$/);
  });
});

describe("makeNetworkDetailReadScript", () => {
  it("includes the requestId in the script", () => {
    const script = makeNetworkDetailReadScript("rn-net-42");
    expect(script).toContain("rn-net-42");
  });

  it("embeds the requestId as a JSON string literal (safe against quotes/backslashes/injection)", () => {
    // The requestId is interpolated via JSON.stringify, so for any input the
    // byId lookup is exactly `byId[<json-literal>]` — no break-out is possible.
    for (const rid of ["rn-net-1", "rn-net-'q", 'rn-net-"x', "rn-net-\\b", `x"]; evil(); //`]) {
      const script = makeNetworkDetailReadScript(rid);
      expect(script).toContain(`byId[${JSON.stringify(rid)}]`);
    }
  });

  it("encodes a control character instead of injecting it raw (the hand-escaper crashed the parse)", () => {
    const script = makeNetworkDetailReadScript("rn-net-\n5");
    expect(script).toContain('byId["rn-net-\\n5"]');
    // never a raw newline inside the string literal (which would be a SyntaxError)
    expect(script).not.toMatch(/byId\["rn-net-\n/);
  });

  it("escapes standalone backslashes in requestId", () => {
    const script = makeNetworkDetailReadScript("rn-net-\\test");
    expect(script).toContain("rn-net-\\\\test");
  });

  it("reads from __argent_network_by_id", () => {
    const script = makeNetworkDetailReadScript("rn-net-1");
    expect(script).toContain("globalThis.__argent_network_by_id");
  });

  it("includes responseBody in the detail output", () => {
    const script = makeNetworkDetailReadScript("rn-net-1");
    expect(script).toContain("responseBody: entry.responseBody");
  });

  it("returns an error if interceptor is not installed", () => {
    const script = makeNetworkDetailReadScript("rn-net-1");
    expect(script).toContain("Network interceptor not installed");
  });

  it("returns an error if request is not found", () => {
    const script = makeNetworkDetailReadScript("rn-net-1");
    expect(script).toContain("Request not found");
  });

  it("is a valid IIFE", () => {
    const script = makeNetworkDetailReadScript("rn-net-1");
    expect(script.trim()).toMatch(/^\(function\(\)/);
    expect(script.trim()).toMatch(/\)\(\)$/);
  });
});
