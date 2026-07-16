/**
 * Morgen CDP Module
 *
 * Connects to Chrome browser (with web.morgen.so open) via Chrome DevTools
 * Protocol to extract authentication credentials. The session token enables
 * full integration task CRUD through the Morgen API.
 *
 * Flow:
 *   1. Connect via CDP to Chrome (port 9253 by default)
 *   2. Find the morgen.so tab
 *   3. Read morgen-refresh-token and morgen-device-id from localStorage
 *   4. Exchange via POST /identity/refresh → session token (1h TTL)
 */

import CDP from "chrome-remote-interface";
import { resolve } from "path";
import { homedir } from "os";
import {
  cdpPortCandidates,
  cdpTimeoutMs,
  MAX_CDP_TIMEOUT_MS,
  classifyTarget,
  discoverEndpoint,
  getCDPHost,
  noTargetHint,
  rankTargets,
  withTimeout,
  type ConnectionSource,
} from "./cdp-endpoint";

export {
  classifyTarget,
  rankTargets,
  withTimeout,
  noTargetHint,
  cdpPortCandidates,
  type ConnectionSource,
} from "./cdp-endpoint";

const API_BASE = "https://api.morgen.so";
export interface SessionInfo {
  token: string; // AI gateway token (for ai.cf.morgen.so)
  apiToken: string; // Regular API token (for api.morgen.so)
  refreshToken: string;
  deviceId: string;
  expiresAt: number; // Unix timestamp ms
  source?: ConnectionSource; // "electron" or "chrome"
}

/**
 * Resolve session file path at call time so tests can redirect via
 * MORGEN_SESSION_FILE without import-time binding.
 */
function getSessionFile(): string {
  return process.env.MORGEN_SESSION_FILE
    || resolve(homedir(), ".config", "morgen-cli", "session.json");
}

/**
 * The single best target, or null.
 *
 * Prefer rankTargets when you can retry — this cannot survive a wedged tab.
 */
export function pickTarget<T>(targets: T[]): { source: ConnectionSource; target: T } | null {
  return rankTargets(targets)[0] ?? null;
}

/**
 * How many targets the retry loop may spend its budget on.
 *
 * The budget must exceed a single call's timeout or the first wedged target
 * consumes all of it and retry never happens — CDP_TIMEOUT_MS bounds one CALL,
 * so the loop gets a multiple of it.
 */
const TARGET_BUDGET_MULTIPLIER = 3;

/** Check if Morgen is reachable via CDP (Chrome with morgen.so tab or Electron app). */
export async function isMorgenRunning(port?: number): Promise<ConnectionSource | false> {
  try {
    if (port !== undefined) {
      const targets = await CDP.List({ host: getCDPHost(), port });
      return pickTarget(targets)?.source ?? false;
    }
    // No port named: probe the desktop app, then the browser.
    const { targets } = await discoverEndpoint();
    return pickTarget(targets)?.source ?? false;
  } catch {
    return false;
  }
}

/**
 * Run `fn` against the best Morgen target that actually answers.
 *
 * Tries each viable target in rank order (Electron, then web), moving on when
 * one fails or wedges, and always closing the client. Only the CDP work belongs
 * in `fn` — keep network calls outside, so a backend failure is not retried
 * against every tab.
 *
 * Retrying matters because these credentials can only be read with
 * Runtime.evaluate against a page target (localStorage/IndexedDB have no
 * browser-level CDP equivalent, unlike cookies). A page routes through its
 * renderer and a busy renderer never answers, so committing to one target lets
 * a single wedged tab fail a refresh that another open Morgen target could have
 * served. withTimeout bounds each attempt, so a wedge costs a timeout, not the
 * refresh.
 */
/**
 * Bound an attach whose client must be closed if it lands after the timeout.
 *
 * withTimeout only stops waiting — it cannot abort the connect. A slow-attaching
 * renderer that completes after we gave up would otherwise orphan a live CDP
 * websocket, and an open handle keeps the CLI's loop from draining: the command
 * prints success and then hangs.
 */
async function attachWithTimeout(
  host: string,
  port: number,
  target: any,
  what: string,
  ms: number
): Promise<CDP.Client> {
  const attach = CDP({ host, port, target }) as Promise<CDP.Client>;
  const bounded = withTimeout(attach, what, ms);
  bounded.catch(() => {
    attach.then(
      (client) => closeQuietly(client),
      () => {
        // already rejected; nothing to close
      }
    );
  });
  return bounded;
}

/**
 * Close without blocking and without throwing.
 *
 * Not awaited: a close that never settles would hang the caller after the work
 * already succeeded. Its rejection is swallowed explicitly — `void client.close()`
 * inside a try/catch only catches a SYNCHRONOUS throw, so a rejected close()
 * escaped as an unhandledRejection.
 */
function closeQuietly(client: CDP.Client): void {
  try {
    const p = client.close() as unknown;
    if (p && typeof (p as Promise<void>).catch === "function") {
      (p as Promise<void>).catch(() => {});
    }
  } catch {
    // ignore
  }
}

/** Prefer a real diagnostic over a timeout when reporting why every target failed. */
function bestError(errors: unknown[], ports: number[]): Error {
  if (errors.length === 0) return new Error(noTargetHint(ports));
  // A timeout says "a tab was busy"; anything else ("No morgen-refresh-token
  // found") tells the user what to actually do, so surface that instead of
  // whichever target happened to be tried last.
  const substantive = errors.find(
    (e) => e instanceof Error && !/timed out after/.test(e.message)
  );
  return (substantive ?? errors[errors.length - 1]) as Error;
}

/**
 * Run `fn` against the best Morgen target that actually answers.
 *
 * Tries each viable target in rank order (Electron, then web), moving on when
 * one fails or wedges, and always closing the client. Only the CDP work belongs
 * in `fn` — keep network calls outside, so a backend failure is not retried
 * against every tab.
 *
 * Retrying matters because these credentials can only be read with
 * Runtime.evaluate against a page target (localStorage/IndexedDB have no
 * browser-level CDP equivalent, unlike cookies). A page routes through its
 * renderer and a busy renderer never answers, so committing to one target lets
 * a single wedged tab fail a refresh that another open Morgen target could have
 * served.
 *
 * One wall-clock budget covers the whole loop. Without it, each target could
 * burn several timeouts (connect + one per evaluate) and N targets would take
 * minutes of silence before any error.
 */
export async function withMorgenTarget<T>(
  port: number | undefined,
  fn: (client: CDP.Client, source: ConnectionSource) => Promise<T>
): Promise<T> {
  const host = getCDPHost();
  const perCallMs = cdpTimeoutMs();
  // Cap the aggregate. cdpTimeoutMs accepts up to setTimeout's 32-bit ceiling,
  // and multiplying an accepted value could push the budget past it — where the
  // runtime clamps to ~1ms and every call "times out" instantly. That is the
  // precise failure cdpTimeoutMs's own clamp exists to prevent; re-introducing
  // it one multiplication downstream would be a poor joke.
  const budgetMs = Math.min(perCallMs * TARGET_BUDGET_MULTIPLIER, MAX_CDP_TIMEOUT_MS);
  // The budget starts before discovery: a debug endpoint can accept the
  // connection and never answer /json/list, which would hang before any retry
  // logic was reached.
  const end = Date.now() + budgetMs;
  const remaining = () => Math.max(0, end - Date.now());

  // An explicit port is honoured as-is; otherwise probe the desktop app, then
  // the browser. This is the whole point of cdp-endpoint: the two deployments
  // are different ENDPOINTS, not different tabs on one endpoint.
  let resolvedPort: number;
  let targets: any[];
  if (port !== undefined) {
    resolvedPort = port;
    targets = await withTimeout(
      CDP.List({ host, port }) as Promise<any[]>,
      "listing CDP targets",
      Math.min(remaining(), perCallMs)
    );
  } else {
    const endpoint = await discoverEndpoint();
    resolvedPort = endpoint.port;
    targets = endpoint.targets;
  }

  const ranked = rankTargets(targets);
  if (ranked.length === 0) throw new Error(noTargetHint([resolvedPort]));

  const errors: unknown[] = [];

  for (const { source, target } of ranked) {
    if (remaining() === 0) break;
    let client: CDP.Client | null = null;
    try {
      client = await attachWithTimeout(
        host,
        resolvedPort,
        target,
        `connecting to the ${source} target`,
        Math.min(remaining(), perCallMs)
      );
      // Bound fn too. Its own calls are bounded individually, but several of
      // them (connect + creds + email) could otherwise outlast the budget the
      // loop only re-checks BETWEEN targets.
      return await withTimeout(
        fn(client, source),
        `reading from the ${source} target`,
        remaining()
      );
    } catch (err) {
      errors.push(err);
    } finally {
      if (client) closeQuietly(client);
    }
  }
  throw bestError(errors, [resolvedPort]);
}

/** Extract refresh token and device ID from an existing CDP client. */
async function extractCredentialsFromClient(client: CDP.Client): Promise<{
  refreshToken: string;
  deviceId: string;
}> {
  const { Runtime } = client;

  // morgen-refresh-token lives in standard localStorage in both Chrome and
  // Electron. morgen-device-id is in standard localStorage on the web app, but
  // the Electron desktop app stores it in window.electronAPI.localStorage
  // (a custom IPC bridge), accessed via .get(key) — not getItem.
  const result = await withTimeout(Runtime.evaluate({
    expression: `
      (async () => {
        const refreshToken = localStorage.getItem("morgen-refresh-token");
        let deviceId = localStorage.getItem("morgen-device-id");
        if (!deviceId && window.electronAPI?.localStorage?.get) {
          try { deviceId = await window.electronAPI.localStorage.get("morgen-device-id"); }
          catch {}
        }
        return JSON.stringify({ refreshToken, deviceId });
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
  }), "reading Morgen credentials from localStorage");

  const creds = JSON.parse(result.result.value);
  if (!creds.refreshToken) throw new Error("No morgen-refresh-token found in Morgen app");
  if (!creds.deviceId) {
    throw new Error(
      "No morgen-device-id found in Morgen app. " +
      "Log in via the Morgen app once to register a device, then retry."
    );
  }
  return creds;
}

/** Exchange a refresh token for a session token via Morgen's identity API. */
async function exchangeForSession(
  refreshToken: string,
  deviceId: string
): Promise<SessionInfo> {
  const resp = await fetch(`${API_BASE}/identity/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken, deviceId }),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`Token refresh failed (${resp.status}): ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (!data.token) throw new Error("No token in refresh response");

  return {
    token: data.aiToken || data.token, // AI gateway token (preferred for chat)
    apiToken: data.token, // Regular API token (for api.morgen.so)
    refreshToken: data.refreshToken || refreshToken,
    deviceId,
    expiresAt: Date.now() + (data.expiresIn || 3600) * 1000,
  };
}

/** Save session to disk for reuse. */
export async function saveSession(session: SessionInfo): Promise<void> {
  const path = getSessionFile();
  const { dirname } = await import("path");
  await Bun.write(resolve(dirname(path), ".gitkeep"), ""); // ensure dir exists
  await Bun.write(path, JSON.stringify(session, null, 2));
}

/** Load session from disk. Returns null if not found or expired. */
export async function loadSession(): Promise<SessionInfo | null> {
  try {
    const file = Bun.file(getSessionFile());
    if (!(await file.exists())) return null;
    const session: SessionInfo = await file.json();
    // Check if expired (with 5-minute buffer)
    if (session.expiresAt < Date.now() + 5 * 60 * 1000) {
      // Try to refresh using stored credentials
      try {
        const refreshed = await exchangeForSession(session.refreshToken, session.deviceId);
        await saveSession(refreshed);
        return refreshed;
      } catch {
        return null; // Refresh failed, need full re-auth
      }
    }
    return session;
  } catch {
    return null;
  }
}

/**
 * Refresh session using stored credentials (no CDP required).
 * Used on 401 to try token refresh before falling back to CDP.
 * Throws if no stored session or refresh fails.
 */
export async function refreshSession(): Promise<SessionInfo> {
  const file = Bun.file(getSessionFile());
  if (!(await file.exists())) {
    throw new Error("No stored session to refresh");
  }
  const session: SessionInfo = await file.json();
  if (!session.refreshToken || !session.deviceId) {
    throw new Error("Stored session missing refreshToken or deviceId");
  }
  const refreshed = await exchangeForSession(session.refreshToken, session.deviceId);
  refreshed.source = session.source;
  await saveSession(refreshed);
  return refreshed;
}

/**
 * Get a valid session token. Tries cached session first,
 * then extracts from running Morgen app or Chrome browser.
 */
export async function getSessionToken(port?: number): Promise<string> {
  // Try cached session
  const cached = await loadSession();
  if (cached) return cached.token;

  // Extract from running Morgen app or Chrome
  const { creds, source } = await withMorgenTarget(port, async (client, source) => ({
    creds: await extractCredentialsFromClient(client),
    source,
  }));
  const session = await exchangeForSession(creds.refreshToken, creds.deviceId);
  session.source = source;
  await saveSession(session);
  return session.token;
}

/**
 * Authenticate: extract credentials from running Morgen app or Chrome browser
 * and save session. Returns account info for display.
 */
export async function authenticate(port?: number): Promise<{
  email: string;
  expiresAt: number;
  source: ConnectionSource;
}> {
  // Both reads come from whichever target answers, so they cannot disagree.
  const { creds, email, source } = await withMorgenTarget(port, async (client, source) => {
    const creds = await extractCredentialsFromClient(client);
    const result = await withTimeout(
      client.Runtime.evaluate({
        expression: `localStorage.getItem("morgen-email") || "unknown"`,
        returnByValue: true,
      }),
      "reading Morgen account email"
    );
    return { creds, email: result.result.value as string, source };
  });

  const session = await exchangeForSession(creds.refreshToken, creds.deviceId);
  session.source = source;
  await saveSession(session);

  return { email, expiresAt: session.expiresAt, source };
}
