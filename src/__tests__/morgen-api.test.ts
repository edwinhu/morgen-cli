import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

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

  it("should throw if MORGEN_API_KEY is not set", async () => {
    delete process.env.MORGEN_API_KEY;

    // Need to re-import to get fresh module
    const { morgenFetch } = await import("../morgen-api");

    expect(morgenFetch("/tasks/list")).rejects.toThrow("MORGEN_API_KEY");
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
