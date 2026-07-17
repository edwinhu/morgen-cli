/**
 * Test preload — runs once, before ANY test file is evaluated.
 * Wired up in `bunfig.toml` under `[test] preload`.
 *
 * Purpose: make the test suite independent of the developer's real machine state.
 *
 * `morgen-cdp.loadSession()` resolves its path from `MORGEN_SESSION_FILE`, falling
 * back to `~/.config/morgen-cli/session.json` — the developer's REAL logged-in
 * session. Any test that exercises a code path calling `loadSession()` therefore
 * behaved differently depending on whether the developer happened to be logged in.
 *
 * That was a live bug, not a hypothetical: `tools.test.ts`'s "calendarRead fetches
 * events across all accounts" asserts an exact fetch count. With a real session on
 * disk, `loadSession()` returned a token, auth took a different path, and the count
 * went 2 -> 4. The suite was green on CI and on logged-out machines, and red on a
 * logged-in one — with the outcome further scrambled by bun's file order, since
 * `morgen-cdp.test.ts` sets `MORGEN_SESSION_FILE` process-wide at eval time and
 * whether that landed before `tools.test.ts` depended on readdir order.
 *
 * `cli.test.ts` and `tasks.test.ts` had each already hand-rolled their own
 * defensive override ("in case the parent suite set it"). Doing it per-file means
 * every new test file must remember; this makes it true for all of them by default.
 *
 * Individual files may still point the var somewhere of their own (morgen-cdp.test.ts
 * does, to exercise real session writes); this only guarantees the default is never
 * the developer's real session.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

const RUN_TMP_DIR = mkdtempSync(resolve(tmpdir(), "morgen-cli-testrun-"));

// Point at a path inside a fresh temp dir. Nothing has written it, so the default
// loadSession() result is null (logged out) — deterministic on every machine.
process.env.MORGEN_SESSION_FILE = resolve(RUN_TMP_DIR, "session.json");

// A real API key in the developer's shell must not leak into tests either; tests
// that need one set it explicitly.
delete process.env.MORGEN_API_KEY;

process.on("exit", () => {
  try {
    rmSync(RUN_TMP_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});
