import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolve } from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";

// ── Mutable mock state ──
let mockTargets: any[] = [];
let mockCDPClient: any = null;
let mockListShouldThrow = false;
/** Optional per-target client factory, for exercising retry across targets. */
let mockClientForTarget: ((target: any) => any) | null = null;

// Redirect session writes to a per-suite temp dir so tests never touch
// the user's real ~/.config/morgen-cli/session.json.
const TEST_TMP_DIR = mkdtempSync(resolve(tmpdir(), "morgen-cli-test-"));
process.env.MORGEN_SESSION_FILE = resolve(TEST_TMP_DIR, "session.json");
process.on("exit", () => { try { rmSync(TEST_TMP_DIR, { recursive: true, force: true }); } catch {} });

// ── Mock chrome-remote-interface BEFORE importing module under test ──
mock.module("chrome-remote-interface", () => {
  const cdpFn = async (opts: any) =>
    mockClientForTarget ? mockClientForTarget(opts?.target) : mockCDPClient;
  cdpFn.List = async (_opts: any) => {
    if (mockListShouldThrow) throw new Error("ECONNREFUSED");
    return mockTargets;
  };
  return { default: cdpFn };
});

// Import the REAL morgen-cdp module via absolute path with cache-busting query
// to avoid getting the stub mock set by other test files (chat.test.ts, morgen-api.test.ts).
const cdpModulePath = resolve(import.meta.dir, "../morgen-cdp.ts");
const mod = await import(cdpModulePath + "?test-cdp");
const isMorgenRunning = mod.isMorgenRunning as typeof import("../morgen-cdp").isMorgenRunning;
const authenticate = mod.authenticate as typeof import("../morgen-cdp").authenticate;
const getSessionToken = mod.getSessionToken as typeof import("../morgen-cdp").getSessionToken;

// ── Helpers ──
const originalFetch = globalThis.fetch;

function makeElectronTarget() {
  return { type: "page", title: "Morgen Calendar", url: "morgen://./app.html" };
}

function makeChromeTarget() {
  return { type: "page", title: "Morgen - Calendar & Tasks", url: "https://app.morgen.so/tasks" };
}

function makeUnrelatedTarget() {
  return { type: "page", title: "Google", url: "https://google.com" };
}

function makeMockCDPClient(overrides: Record<string, any> = {}) {
  const evaluateResults: any[] = overrides.evaluateResults || [
    // extractCredentialsFromClient call
    { result: { value: JSON.stringify({ refreshToken: "rt-123", deviceId: "dev-456" }) } },
    // email fetch call
    { result: { value: "test@morgen.so" } },
  ];
  let evalIndex = 0;

  return {
    Runtime: {
      evaluate: async (_opts: any) => evaluateResults[evalIndex++],
    },
    close: async () => {},
  };
}

function mockIdentityRefresh(tokenData: Record<string, any> = {}) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/identity/refresh")) {
      return new Response(
        JSON.stringify({
          token: "api-tok-abc",
          aiToken: "ai-tok-xyz",
          refreshToken: "rt-refreshed",
          expiresIn: 3600,
          ...tokenData,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return originalFetch(input as any, init);
  }) as typeof fetch;
}

// ── Tests ──

describe("isMorgenRunning", () => {
  beforeEach(() => {
    mockTargets = [];
    mockListShouldThrow = false;
  });

  it('returns "electron" when Electron target found', async () => {
    mockTargets = [makeElectronTarget(), makeChromeTarget()];
    const result = await isMorgenRunning(9400);
    expect(result).toBe("electron");
  });

  it('returns "chrome" when only morgen.so URL target exists', async () => {
    mockTargets = [makeUnrelatedTarget(), makeChromeTarget()];
    const result = await isMorgenRunning(9400);
    expect(result).toBe("chrome");
  });

  it("returns false when CDP.List throws (no server)", async () => {
    mockListShouldThrow = true;
    const result = await isMorgenRunning(9400);
    expect(result).toBe(false);
  });

  it("returns false when no matching targets found", async () => {
    mockTargets = [makeUnrelatedTarget()];
    const result = await isMorgenRunning(9400);
    expect(result).toBe(false);
  });
});

describe("authenticate", () => {
  beforeEach(() => {
    mockTargets = [];
    mockListShouldThrow = false;
    mockCDPClient = makeMockCDPClient();
    mockIdentityRefresh();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns source: "electron" when Electron target found', async () => {
    mockTargets = [makeElectronTarget()];
    const result = await authenticate(9400);
    expect(result.source).toBe("electron");
    expect(result.email).toBe("test@morgen.so");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('returns source: "chrome" when Chrome fallback used', async () => {
    mockTargets = [makeChromeTarget()];
    const result = await authenticate(9400);
    expect(result.source).toBe("chrome");
    expect(result.email).toBe("test@morgen.so");
  });

  it("returns email from localStorage", async () => {
    mockCDPClient = makeMockCDPClient({
      evaluateResults: [
        { result: { value: JSON.stringify({ refreshToken: "rt-123", deviceId: "dev-456" }) } },
        { result: { value: "user@example.com" } },
      ],
    });
    mockTargets = [makeElectronTarget()];
    const result = await authenticate(9400);
    expect(result.email).toBe("user@example.com");
  });

  it("throws descriptive error when no targets found", async () => {
    mockTargets = [makeUnrelatedTarget()];
    await expect(authenticate(9400)).rejects.toThrow("No Morgen target found");
  });

  it("error message includes both start commands", async () => {
    mockTargets = [];
    try {
      await authenticate(9400);
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain("Desktop app:");
      expect(err.message).toContain("Web app:");
    }
  });
});

describe("getSessionToken", () => {
  beforeEach(() => {
    mockTargets = [];
    mockListShouldThrow = false;
    mockCDPClient = makeMockCDPClient();
    mockIdentityRefresh();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("extracts token from CDP when no cached session", async () => {
    mockTargets = [makeElectronTarget()];
    const token = await getSessionToken(9400);
    expect(token).toBe("ai-tok-xyz");
  });
});

describe("target resilience", () => {
  beforeEach(() => {
    mockTargets = [];
    mockCDPClient = null;
    mockClientForTarget = null;
    mockListShouldThrow = false;
  });

  afterEach(() => {
    mockClientForTarget = null;
    globalThis.fetch = originalFetch;
    delete process.env.CDP_TIMEOUT_MS;
  });

  it("a wedged target does not fail the refresh when another can serve it", async () => {
    // Two Morgen web targets. The first never answers Runtime.evaluate — the
    // real failure mode, a busy renderer. The second must still serve it.
    const wedged = { id: "wedged", type: "page", url: "https://web.morgen.so/wedged" };
    const good = { id: "good", type: "page", url: "https://web.morgen.so/good" };
    mockTargets = [wedged, good];

    mockClientForTarget = (target: any) => ({
      Runtime: {
        evaluate: async (opts: any) => {
          if (target?.id === "wedged") return new Promise(() => {}); // never settles
          if (String(opts.expression).includes("morgen-email")) {
            return { result: { value: "user@example.com" } };
          }
          return {
            result: { value: JSON.stringify({ refreshToken: "rt", deviceId: "did" }) },
          };
        },
      },
      close: async () => {},
    });

    process.env.CDP_TIMEOUT_MS = "150"; // keep the wedged attempt short
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ token: "api-tok", aiToken: "ai-tok", expiresIn: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const res = await authenticate(9999);
    expect(res.email).toBe("user@example.com");
  });

  it("surfaces the last error when every target is wedged", async () => {
    mockTargets = [
      { id: "a", type: "page", url: "https://web.morgen.so/a" },
      { id: "b", type: "page", url: "https://web.morgen.so/b" },
    ];
    mockClientForTarget = () => ({
      Runtime: { evaluate: async () => new Promise(() => {}) },
      close: async () => {},
    });
    process.env.CDP_TIMEOUT_MS = "100";

    // Must reject with the timeout, not hang and not swallow it.
    await expect(authenticate(9999)).rejects.toThrow(/timed out after 100ms/);
  });
});
