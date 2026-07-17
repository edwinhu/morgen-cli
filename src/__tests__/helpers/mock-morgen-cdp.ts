import { mock } from "bun:test";
import { resolve } from "path";

type MorgenCdp = typeof import("../../morgen-cdp");

/**
 * Register a module mock for `src/morgen-cdp.ts` that is COMPLETE by construction.
 *
 * Why this helper exists
 * ──────────────────────
 * `mock.module` in bun is process-global and permanent for the whole `bun test`
 * run: it is keyed by resolved module path, and it is NOT undone by
 * `mock.restore()` (verified on bun 1.3.14 — `mock.restore()` restores spies
 * only; a `mock.module` registration survives it). It also cannot be scoped to
 * one test file. So whatever any test file registers for `../morgen-cdp` is what
 * EVERY later-loading test file sees when it does a plain static
 * `import { x } from "../morgen-cdp"`.
 *
 * That made incomplete stubs a platform-dependent landmine. A stub literal that
 * omitted, say, `classifyTarget` caused any later file importing it to die with
 *
 *     SyntaxError: Export named 'classifyTarget' not found in module .../morgen-cdp.ts
 *
 * ...but only when bun happened to load the mocking file first. bun's file order
 * differs between Linux and macOS, so the same commit was green on one and red on
 * the other.
 *
 * The fix: never hand-write the stub's export surface. This helper spreads the
 * REAL module (loaded via a cache-busting query so it is the genuine module even
 * if another test file already registered a mock) and applies `overrides` on top.
 * The registered mock therefore always carries the real module's full export
 * surface, so a leak into another test file can never produce a missing-export
 * SyntaxError. Overridden keys are stubbed; everything else stays real.
 *
 * Always use this instead of calling `mock.module("../morgen-cdp", ...)` directly.
 * `src/__tests__/mock-isolation.test.ts` enforces that mechanically.
 *
 * @param overrides Partial stub. Typed against the real module, so you cannot
 *                  stub an export that does not exist or with a wrong signature.
 */
export async function mockMorgenCdp(overrides: Partial<MorgenCdp>): Promise<void> {
  const realPath = resolve(import.meta.dir, "../../morgen-cdp.ts");
  // Cache-busting query => the genuine module, never a previously-registered mock.
  const real = (await import(realPath + "?real-base")) as MorgenCdp;
  mock.module(realPath, () => ({ ...real, ...overrides }));
}
