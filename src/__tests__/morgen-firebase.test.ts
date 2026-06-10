import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolve } from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";

// ── Mutable mock state ──
let mockTargets: any[] = [];
let mockEvalResult: any = null;

const TEST_TMP_DIR = mkdtempSync(resolve(tmpdir(), "morgen-fb-test-"));
process.env.MORGEN_FIREBASE_FILE = resolve(TEST_TMP_DIR, "firebase.json");
process.on("exit", () => {
  try {
    rmSync(TEST_TMP_DIR, { recursive: true, force: true });
  } catch {}
});

// Mock chrome-remote-interface before importing the module under test.
mock.module("chrome-remote-interface", () => {
  const cdpFn = async (_opts: any) => ({
    Runtime: { evaluate: async (_e: any) => ({ result: { value: mockEvalResult } }) },
    close: async () => {},
  });
  cdpFn.List = async (_opts: any) => mockTargets;
  return { default: cdpFn };
});

const fbModulePath = resolve(import.meta.dir, "../morgen-firebase.ts");
const mod = await import(fbModulePath + "?test-fb");
const getFirebaseSession = mod.getFirebaseSession as typeof import("../morgen-firebase").getFirebaseSession;
const authenticateFirebase = mod.authenticateFirebase as typeof import("../morgen-firebase").authenticateFirebase;

const originalFetch = globalThis.fetch;
const FB_FILE = process.env.MORGEN_FIREBASE_FILE!;

function mockSecureToken(idToken = "fresh-id-token") {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("securetoken.googleapis.com")) {
      return new Response(
        JSON.stringify({
          id_token: idToken,
          refresh_token: "new-rt",
          expires_in: "3600",
          user_id: "uid-123",
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function makeIdbValue(creds: { uid: string; refreshToken: string; apiKey: string }) {
  return JSON.stringify(creds);
}

describe("morgen-firebase", () => {
  beforeEach(async () => {
    mockTargets = [];
    mockEvalResult = null;
    try {
      await Bun.file(FB_FILE).delete();
    } catch {}
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns a cached id token without any network when still valid", async () => {
    await Bun.write(
      FB_FILE,
      JSON.stringify({
        uid: "cached-uid",
        refreshToken: "rt",
        apiKey: "ak",
        idToken: "cached-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
      })
    );
    globalThis.fetch = (async () => {
      throw new Error("should not fetch");
    }) as typeof fetch;
    const session = await getFirebaseSession();
    expect(session.idToken).toBe("cached-token");
    expect(session.uid).toBe("cached-uid");
  });

  it("refreshes via securetoken when the cached token is expired (no CDP)", async () => {
    await Bun.write(
      FB_FILE,
      JSON.stringify({
        uid: "cached-uid",
        refreshToken: "rt",
        apiKey: "ak",
        idToken: "old-token",
        expiresAt: Date.now() - 1000, // expired
      })
    );
    mockSecureToken("refreshed-token");
    const session = await getFirebaseSession();
    expect(session.idToken).toBe("refreshed-token");
    // Persisted for reuse.
    const saved = await Bun.file(FB_FILE).json();
    expect(saved.idToken).toBe("refreshed-token");
  });

  it("extracts credentials from the running app when no cache exists", async () => {
    mockTargets = [{ type: "page", url: "morgen://./app.html" }];
    mockEvalResult = makeIdbValue({ uid: "app-uid", refreshToken: "app-rt", apiKey: "app-ak" });
    mockSecureToken("token-from-app");
    const session = await authenticateFirebase();
    expect(session.idToken).toBe("token-from-app");
    expect(session.refreshToken).toBe("new-rt");
  });

  it("throws a helpful error when the Morgen app is not reachable", async () => {
    mockTargets = []; // no targets
    await expect(authenticateFirebase()).rejects.toThrow(/No Morgen target/);
  });
});
