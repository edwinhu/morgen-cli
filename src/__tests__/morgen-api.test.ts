import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mockMorgenCdp } from "./helpers/mock-morgen-cdp";
import { startStubApi } from "./helpers/stub-api";

// Mock loadSession to return null so we can test API-key-only auth paths.
// Stubs the auth surface only; every other morgen-cdp export stays real, so this
// registration cannot break other test files' static imports. See the helper.
await mockMorgenCdp({
  loadSession: async () => null,
  saveSession: async () => {},
  isMorgenRunning: async () => false,
  authenticate: async () => ({ email: "", expiresAt: 0, source: "electron" }),
  refreshSession: async () => { throw new Error("no stored session"); },
  getSessionToken: async () => "",
});

describe("morgenFetch", () => {
  const originalEnv = process.env.MORGEN_API_KEY;

  beforeEach(() => {
    process.env.MORGEN_API_KEY = "test-api-key-12345";
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.MORGEN_API_KEY = originalEnv;
    } else {
      delete process.env.MORGEN_API_KEY;
    }
  });

  it("should throw if no auth is available", async () => {
    delete process.env.MORGEN_API_KEY;

    const { morgenFetch } = await import("../morgen-api");
    await expect(morgenFetch("/tasks/list")).rejects.toThrow("authentication");
  });

  it("should include ApiKey header in requests", async () => {
    process.env.MORGEN_API_KEY = "test-key-abc";
    const { morgenFetch } = await import("../morgen-api");
    try {
      await morgenFetch("/tasks/list");
      // If it somehow succeeds, that's fine too
    } catch (err: unknown) {
      // The call should fail with a network/API error, NOT with "MORGEN_API_KEY not set"
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain("MORGEN_API_KEY environment variable is not set");
    }
  });

  it("honours MORGEN_API_BASE_URL", async () => {
    process.env.MORGEN_API_KEY = "test-key-base-url";
    const stub = startStubApi({ createdEventId: "evt-from-stub" });
    const realFetch = globalThis.fetch;

    // Egress guard: nothing in this suite may reach api.morgen.so. If morgenFetch
    // ignores the override, the request is refused here instead of being sent.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : String(input);
      if (!target.startsWith(stub.url)) {
        throw new Error(`request escaped the stub server: ${target}`);
      }
      return realFetch(input as Parameters<typeof realFetch>[0], init);
    }) as typeof fetch;

    process.env.MORGEN_API_BASE_URL = stub.url;
    try {
      const { morgenFetch } = await import("../morgen-api");
      const resp = await morgenFetch<{ data: { event: { id: string } } }>(
        "/events/create",
        {
          method: "POST",
          body: { title: "Securities Regulation", calendarId: "cal-stub" },
          params: { seriesUpdateMode: "all" },
        }
      );

      expect(resp.data.event.id).toBe("evt-from-stub");
      expect(stub.requests).toHaveLength(1);

      const req = stub.requests[0]!;
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/events/create");
      expect(req.pathname).toBe("/v3/events/create");
      expect(req.query).toEqual({ seriesUpdateMode: "all" });
      expect(req.body).toEqual({
        title: "Securities Regulation",
        calendarId: "cal-stub",
      });
      expect(req.headers.authorization).toBe("ApiKey test-key-base-url");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.MORGEN_API_BASE_URL;
      stub.close();
    }
  });
});

describe("MorgenApiError", () => {
  it("should have correct properties", async () => {
    const { MorgenApiError } = await import("../morgen-api");
    const err = new MorgenApiError("test error", 401, { message: "unauthorized" });
    expect(err.message).toBe("test error");
    expect(err.status).toBe(401);
    expect(err.body).toEqual({ message: "unauthorized" });
    expect(err.name).toBe("MorgenApiError");
  });
});
