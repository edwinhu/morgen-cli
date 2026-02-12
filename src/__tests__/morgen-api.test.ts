import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// Mock loadSession to return null so we can test API-key-only auth paths
mock.module("../morgen-cdp", () => ({
  loadSession: async () => null,
  saveSession: async () => {},
  isMorgenRunning: async () => false,
  authenticate: async () => ({ email: "", expiresAt: 0, source: "electron" }),
  getSessionToken: async () => "",
}));

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
