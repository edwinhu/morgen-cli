
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

