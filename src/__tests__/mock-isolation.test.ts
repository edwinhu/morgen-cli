import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";

/**
 * Guard tests for the module-mock isolation hazard.
 *
 * `mock.module` is process-global, permanent (survives `mock.restore()` on bun
 * 1.3.14), and applies to every test file loaded afterwards. An incomplete stub
 * for a module that other test files import statically is therefore a
 * platform-dependent flake: green wherever bun loads the files in a lucky order,
 * red elsewhere. See `helpers/mock-morgen-cdp.ts` for the full story.
 *
 * The first test below is the real guard: it reads source text, so it is
 * order-independent and fails identically on every platform. The second is a
 * best-effort canary on actual module state — it can only catch a leak when bun
 * happens to load it after the offending file, which is exactly the coin-flip
 * the first test exists to remove. Do not rely on the canary alone.
 */

const TEST_DIR = import.meta.dir;

function testFiles(): string[] {
  return readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts"));
}

describe("mock.module isolation", () => {
  test("no test file registers a raw mock.module for morgen-cdp", () => {
    // A raw registration hand-writes the stub's export surface, which is how the
    // missing-export SyntaxError gets reintroduced. Route it through
    // mockMorgenCdp(), which spreads the real module and cannot be incomplete.
    const offenders: string[] = [];
    for (const file of testFiles()) {
      if (file === "mock-isolation.test.ts") continue;
      const src = readFileSync(resolve(TEST_DIR, file), "utf8");
      // Matches mock.module("../morgen-cdp"), './morgen-cdp', with or without .ts
      if (/mock\.module\(\s*["'`][^"'`]*morgen-cdp(\.ts)?["'`]/.test(src)) {
        offenders.push(file);
      }
    }

    expect(
      offenders,
      `These files call mock.module() on morgen-cdp directly. That stub leaks into ` +
        `every later-loading test file and breaks any static import of an export it ` +
        `omits. Use mockMorgenCdp() from ./helpers/mock-morgen-cdp instead.`,
    ).toEqual([]);
  });

  test("a leaked morgen-cdp mock still exposes the real module's full export surface", async () => {
    // Canary (see file header): only meaningful if a mocking file loaded before
    // this one, which depends on bun's file order. When it does run after one,
    // it asserts the property that matters end-to-end: whatever mock is
    // registered, a plain static import of ANY real export must still resolve.
    // This is what morgen-target.test.ts relies on.
    const realPath = resolve(TEST_DIR, "../morgen-cdp.ts");
    const real = await import(realPath + "?isolation-guard-real");
    const asSeenByImporters = await import("../morgen-cdp");

    const missing = Object.keys(real).filter((k) => !(k in asSeenByImporters));

    expect(
      missing,
      `Exports present in the real morgen-cdp but missing from what importers ` +
        `resolve. A registered module mock is incomplete; importing any of these ` +
        `statically throws "Export named 'x' not found in module".`,
    ).toEqual([]);
  });
});
