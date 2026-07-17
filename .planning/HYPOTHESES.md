
### Iteration: morgen-cli isWebTarget apex-fallback (2026-07-17)

## Current Hypothesis
H1: `isWebTarget` (`src/cdp-endpoint.ts:68-70`, `return hostMatches(url, "morgen.so")`)
checks the apex domain instead of the real app UI hosts, so ANY subdomain of morgen.so
classifies as `chrome` — including `book.morgen.so` (public booking page, confirmed real
subdomain used by Open Invites per docs/investigations/2026-06-10_open-invites.md:31),
`api.morgen.so` (REST API host, src/morgen-api.ts:12), `accounts.morgen.so` (illustrative
impostor example from the bug report), and `morgen.so/blog`. Since Electron never wins on
Linux (no desktop app), `isMorgenRunning`/`pickTarget` picks the first `chrome`-classified
page target — an impostor tab left open beats or masks the real web.morgen.so tab, and
`withMorgenTarget` attaches and runs localStorage-reading JS in it.

## Evidence: real app hosts (from codebase, not taste)
- `web.morgen.so` — the WEB_APP_URL const (src/cdp-endpoint.ts:98), confirmed live on
  CDP port 9222 right now: `page https://web.morgen.so/` (real logged-in tab, verified via
  `env -u CDP_PORT curl -s http://localhost:9222/json`).
- `app.morgen.so` — documented legacy host in the existing test
  (src/__tests__/morgen-target.test.ts:83-88, "morgen.so is the web app, on any subdomain"
  — app.morgen.so is called out explicitly as "the older host" that must still classify).
- NOT app hosts (real subdomains serving something other than the logged-in app UI):
  `api.morgen.so` (REST API, src/morgen-api.ts:12, src/open-invite.ts:18),
  `book.morgen.so` (public booking pages, no login required, src/open-invite.ts:19,
  docs/investigations/2026-06-10_open-invites.md:31),
  `platform.morgen.so` (API key portal, README.md:16),
  `ai.cf.morgen.so` (chat backend, src/chat.ts:24),
  `docs.morgen.so` (docs site, src/types.ts:4).
- No `accounts.morgen.so` host appears anywhere in the codebase — it is illustrative of
  the bug class, not a confirmed real host, but the fix (allowlist) excludes it regardless.

## Hypothesis Log
| # | Hypothesis | Test | Result |
|---|-----------|------|--------|
| H1 | apex-domain match in isWebTarget causes false positives on book/api/accounts/blog subdomains, which pickTarget then classifies as "chrome" and withMorgenTarget attaches credential JS to | New regression test in src/__tests__/morgen-target.test.ts: classifyTarget on book.morgen.so, api.morgen.so, accounts.morgen.so, morgen.so/blog must NOT be "chrome" | CONFIRMED — pre-fix, `https://book.morgen.so/abc123` classified as `"chrome"` (assertion `not.toBe("chrome")` failed, received "chrome"); test suite: 1 fail. |

### Failing output (pre-fix)
```
✗ classifyTarget > REGRESSION: non-app morgen.so subdomains are NOT the web app
  expect(classifyTarget(page("https://book.morgen.so/abc123"))).not.toBe("chrome")
  Expected: not "chrome"

 31 pass
 1 fail
```

### Fix
Replaced the apex `hostMatches(url, "morgen.so")` with an explicit allowlist of the two
documented app hosts: `WEB_APP_HOSTS = ["web.morgen.so", "app.morgen.so"]`, checked via
`WEB_APP_HOSTS.some((host) => hostMatches(url, host))`. `hostMatches` still does the
subdomain/canonicalization/scheme work per-host, so `web.morgen.so.` (trailing dot) and
`foo.web.morgen.so` still match, but `api.morgen.so`, `book.morgen.so`,
`accounts.morgen.so`, and bare `morgen.so` no longer do.

### Post-fix verification
- New regression test: 32 pass / 0 fail in src/__tests__/morgen-target.test.ts.
- Full suite: `bun test` → 161 pass / 1 skip / 0 fail (was 160 pass baseline + 1 new test).
- `bunx tsc --noEmit --pretty false 2>&1 | grep -c "error TS"` → 75 (unchanged from baseline).
- Required real shapes, spot-checked directly against classifyTarget: `morgen://./app.html`
  → electron; `file:///opt/Morgen/resources/app.html` → electron; `https://web.morgen.so/`
  → chrome; `https://app.morgen.so/tasks` → chrome; `https://web.morgen.so./calendar`
  (FQDN trailing dot) → chrome. All OK.
- Cross-repo invariant: `diff <(sed -n '/END PRODUCT BLOCK/,$p' morgen-cli/.../src/cdp-endpoint.ts) <(sed -n '/END PRODUCT BLOCK/,$p' superhuman-cli/.../src/cdp-endpoint.ts)` → empty (exit 0). The fix is entirely inside the PRODUCT BLOCK, so no drift.

### Iteration: morgen-target.test.ts cross-file mock.module leak (2026-07-17)

## Phase 0/1: Triage, Reproduce

Confirmed on Linux: `morgen-target.test.ts` does a plain top-level
`import { classifyTarget, pickTarget, rankTargets, noTargetHint, withTimeout } from "../morgen-cdp"`.
Four files call bun's GLOBAL `mock.module`: `morgen-api.test.ts` and `chat.test.ts` both
`mock.module("../morgen-cdp", () => ({ loadSession, saveSession, isMorgenRunning, authenticate,
refreshSession, getSessionToken }))` — a stub object with NONE of classifyTarget/pickTarget/
rankTargets/noTargetHint/withTimeout. `morgen-firebase.test.ts` and `morgen-cdp.test.ts` mock
`chrome-remote-interface`, not `../morgen-cdp`, so they are not implicated. `morgen-cdp.test.ts`
already dodges the exact same hazard (comment at line 30-31: "Import the REAL morgen-cdp module
via absolute path with cache-busting query to avoid getting the stub mock set by other test files
(chat.test.ts, morgen-api.test.ts)") — proof the hazard is known and already has a working pattern
in-repo, just not applied to morgen-target.test.ts.

Reproduced by forcing bun to run a mocking file before morgen-target.test.ts:
```
$ bun test src/__tests__/chat.test.ts src/__tests__/morgen-target.test.ts
src/__tests__/morgen-target.test.ts:
# Unhandled error between tests
-------------------------------
SyntaxError: Export named 'classifyTarget' not found in module
'.../src/morgen-cdp.ts'.
-------------------------------
 16 pass
 1 skip
 1 fail
 1 error
Ran 18 tests across 2 files.
```
Exactly the macOS symptom, reproduced on Linux by controlling file order — bun's default
alphabetical/discovery order on this machine happens to run `morgen-target.test.ts` before any
mocking file, which is why the full suite is 161/0 here but the hazard is real.

## Phase 2: Investigate — where do the 5 symbols live?

`classifyTarget`, `rankTargets`, `withTimeout`, `noTargetHint` are defined in `src/cdp-endpoint.ts`
and merely re-exported by `src/morgen-cdp.ts` (`export { classifyTarget, rankTargets, withTimeout,
noTargetHint } from "./cdp-endpoint"`, morgen-cdp.ts:32-36). No test file mocks `../cdp-endpoint`
(grep confirms only `../morgen-cdp` and `chrome-remote-interface` are ever passed to
`mock.module`), so importing those 4 directly from `../cdp-endpoint` would sidestep the mock
entirely and structurally cannot be poisoned by a `mock.module("../morgen-cdp", ...)` stub
anywhere in the suite, present or future.

BUT `pickTarget` (`return rankTargets(targets)[0] ?? null`) is defined directly in
`morgen-cdp.ts` itself (line 65), NOT re-exported from cdp-endpoint.ts — it has no "real home"
outside the mocked module. Splitting the import (4 symbols from cdp-endpoint, 1 from morgen-cdp)
would still leave pickTarget exposed to the same hazard, and is also less uniform/harder to reason
about than one mechanism for all 5.

Decision: use the SAME cache-busting absolute-import pattern morgen-cdp.test.ts already uses,
applied to `../morgen-cdp` for all 5 symbols. This is simplest (one mechanism, not two), matches
an already-reviewed and working in-repo precedent exactly, and is robust to `pickTarget` not
existing in cdp-endpoint.ts. Query string must differ from morgen-cdp.test.ts's `?test-cdp` (e.g.
`?test-target`) since bun's module cache key includes the query.

## Current Hypothesis
H1: Replacing morgen-target.test.ts's static `import { classifyTarget, pickTarget, rankTargets,
noTargetHint, withTimeout } from "../morgen-cdp"` with a cache-busting dynamic
`await import(resolve(import.meta.dir, "../morgen-cdp.ts") + "?test-target")`, matching
morgen-cdp.test.ts's established pattern, makes morgen-target.test.ts immune to any
`mock.module("../morgen-cdp", ...)` set by chat.test.ts/morgen-api.test.ts regardless of file
execution order, because bun's mock.module only intercepts the STATIC specifier `"../morgen-cdp"`
resolved through the module registry at its ORIGINAL (non-cache-busted) cache key — a fresh
`import()` with an appended query string is a different cache key.

## Hypothesis Log
| # | Hypothesis | Test | Result |
|---|-----------|------|--------|
| H1 | cache-busting dynamic import of ../morgen-cdp.ts (same pattern as morgen-cdp.test.ts) makes morgen-target.test.ts immune to the mock.module leak from chat.test.ts/morgen-api.test.ts, regardless of order | Forced order `bun test chat.test.ts morgen-target.test.ts` before and after fix; also `bun test morgen-api.test.ts morgen-target.test.ts` after fix | CONFIRMED |

### Fix applied and verified

`src/__tests__/morgen-target.test.ts`: replaced the static
`import { classifyTarget, pickTarget, rankTargets, noTargetHint, withTimeout } from "../morgen-cdp"`
with a cache-busting dynamic import identical in shape to morgen-cdp.test.ts's existing pattern —
`const mod = await import(resolve(import.meta.dir, "../morgen-cdp.ts") + "?test-target")`, then
destructuring the 5 symbols off `mod` with `typeof import("../morgen-cdp").X` casts for type
safety. `hostMatches` (from `../cdp-endpoint`, never mocked) is left as a plain static import,
unchanged. No source file touched — one test file only.

### Post-fix verification
- Regression order, BEFORE fix (pasted above): `bun test chat.test.ts morgen-target.test.ts` →
  16 pass / 1 skip / 1 fail / 1 error, `SyntaxError: Export named 'classifyTarget' not found`.
- Regression order, AFTER fix: `bun test chat.test.ts morgen-target.test.ts` → 48 pass / 1 skip /
  0 fail.
- Second hazard order (the other mocking file), AFTER fix: `bun test morgen-api.test.ts
  morgen-target.test.ts` → 35 pass / 0 fail.
- Full suite, normal order: `bun test` → 161 pass / 1 skip / 0 fail (baseline held, no
  regression, no new tests added this iteration).
- `bunx tsc --noEmit --pretty false 2>&1 | grep -c "error TS"` → 75 (== main baseline, unchanged).

### Structural note (not fixed this iteration, per scope)
This fix AVOIDS the hazard for morgen-target.test.ts specifically; it does not make the hazard
structurally impossible suite-wide. `morgen-firebase.test.ts` and `morgen-cdp.test.ts` mock
`chrome-remote-interface` (not `../morgen-cdp`), so they don't collide with `chat.test.ts` /
`morgen-api.test.ts`'s `../morgen-cdp` mocks, and `morgen-cdp.test.ts` already self-protects via
the same cache-busting pattern. But any FUTURE test file that does a plain static
`import ... from "../morgen-cdp"` (or `"../cdp-endpoint"`, if that ever gets mocked) reintroduces
this exact class of order-dependent flake with no lint/CI guard against it. A structural fix
(e.g. `afterEach(() => mock.restore())` in the two mocking files, or a bunfig.toml
`preload`-based per-file module registry reset) was NOT attempted — out of scope for this single
hypothesis per the one-hypothesis-per-invocation rule, and would touch shared test infra beyond
the 1-file budget used here. Flagging for a follow-up iteration.

