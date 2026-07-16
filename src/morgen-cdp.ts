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

const API_BASE = "https://api.morgen.so";
const DEFAULT_PORT = parseInt(process.env.CDP_PORT || "9253", 10);
const DEFAULT_CDP_TIMEOUT_MS = 10_000;

/**
 * Upper bound on any single CDP round-trip. Override with CDP_TIMEOUT_MS.
 *
 * Resolved at call time, not import time — the same reason getSessionFile() is:
 * a module-level const captures the env before a test (or a caller) can set it.
 *
 * Validated rather than trusted: parseInt("garbage") is NaN and
 * setTimeout(fn, NaN) fires immediately, so a typo would make every CDP call
 * "time out" instantly and every refresh fail with a misleading message.
 */
function cdpTimeoutMs(): number {
  const raw = process.env.CDP_TIMEOUT_MS;
  if (!raw) return DEFAULT_CDP_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CDP_TIMEOUT_MS;
  return n;
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
 * Get CDP host from environment or default to localhost
 */
function getCDPHost(): string {
  return process.env.CDP_HOST || process.env.HOST_IP || "localhost";
}

export type ConnectionSource = "electron" | "chrome";

export interface SessionInfo {
  token: string; // AI gateway token (for ai.cf.morgen.so)
  apiToken: string; // Regular API token (for api.morgen.so)
  refreshToken: string;
  deviceId: string;
  expiresAt: number; // Unix timestamp ms
  source?: ConnectionSource; // "electron" or "chrome"
}

/**
 * Bound a CDP call. Credentials here live in localStorage/IndexedDB, so they
 * must be read with Runtime.evaluate against a page target — there is no
 * browser-level equivalent as there is for cookies. That means a wedged
 * renderer can swallow the call: observed live in a sibling tool, where a
 * playing YouTube tab never answered a CDP command while four other tabs
 * answered instantly. Without a bound, that is an indefinite hang and no error.
 */
export function withTimeout<T>(p: Promise<T>, what: string, ms = cdpTimeoutMs()): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms — is the Morgen tab responsive?`)),
      ms
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/** Classify a CDP target as Morgen Electron, Chrome web app, or neither. */
export function classifyTarget(t: any): ConnectionSource | null {
  if (t.type !== "page") return null;
  const url: string | undefined = t.url;
  if (!url) return null;

  // The desktop app loads morgen://./app.html.
  if (url.startsWith("morgen://")) return "electron";

  // Some builds surface a bare app.html path instead of the morgen:// scheme.
  // It must still be Morgen's: a bare `app.html` match is far too broad —
  // 1Password's extension serves
  // chrome-extension://<id>/app/app.html#/page/settings, which was being
  // classified as the Morgen desktop app and, since Electron ranks first,
  // picked ahead of the real web.morgen.so tab. Reading credentials from
  // 1Password's localStorage then failed the whole refresh.
  if (url.includes("app.html") && /morgen/i.test(url)) return "electron";

  if (url.includes("morgen.so")) return "chrome";
  return null;
}

/**
 * Rank every viable Morgen target, best first: Electron before web (richer
 * credentials via the electronAPI bridge).
 *
 * Every one, not just the best: credentials here live in localStorage and
 * IndexedDB, so they must be read with Runtime.evaluate against a page target —
 * there is no browser-level equivalent as there is for cookies. A page routes
 * through its renderer, and a busy renderer never answers, so committing to a
 * single target means one wedged tab fails the whole refresh even when another
 * viable Morgen target is sitting right there. Measured in a sibling tool: 4 of
 * 8 live page targets were wedged at one point, and which ones drift over time.
 */
export function rankTargets<T>(targets: T[]): Array<{ source: ConnectionSource; target: T }> {
  const ranked: Array<{ source: ConnectionSource; target: T }> = [];
  for (const source of ["electron", "chrome"] as const) {
    for (const target of targets) {
      if (classifyTarget(target) === source) ranked.push({ source, target });
    }
  }
  return ranked;
}

/**
 * The single best Morgen target, or null.
 *
 * Prefer rankTargets when you can retry — this cannot survive a wedged tab.
 */
export function pickTarget<T>(targets: T[]): { source: ConnectionSource; target: T } | null {
  return rankTargets(targets)[0] ?? null;
}

/** Platform-appropriate command for starting the Morgen desktop app with CDP. */
function electronLaunchHint(port: number, platform: string = process.platform): string {
  const bin =
    platform === "darwin"
      ? "/Applications/Morgen.app/Contents/MacOS/Morgen"
      : platform === "win32"
        ? "%LOCALAPPDATA%\\Programs\\Morgen\\Morgen.exe"
        : "morgen"; // Linux: .deb/AppImage put `morgen` on PATH
  return `${bin} --remote-debugging-port=${port}`;
}

/**
 * Error text for "no Morgen target". Names both routes — the desktop app
 * (Electron) and the web app in a browser — since either satisfies the CLI,
 * and only one of them exists on any given platform.
 */
export function noTargetHint(port: number, platform: string = process.platform): string {
  return (
    `No Morgen target found on port ${port}.\n` +
    "Start either route (quit the app first if already open, so the debug port takes effect):\n" +
    `  Desktop app: ${electronLaunchHint(port, platform)}\n` +
    `  Web app:     open https://web.morgen.so in a browser started with --remote-debugging-port=${port}`
  );
}

/** Check if Morgen is reachable via CDP (Chrome with morgen.so tab or Electron app). */
export async function isMorgenRunning(port = DEFAULT_PORT): Promise<ConnectionSource | false> {
  try {
    const host = getCDPHost();
    const targets = await CDP.List({ host, port });
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
async function withMorgenTarget<T>(
  port: number,
  fn: (client: CDP.Client, source: ConnectionSource) => Promise<T>
): Promise<T> {
  const host = getCDPHost();
  const targets = await CDP.List({ host, port });

  const ranked = rankTargets(targets);
  if (ranked.length === 0) throw new Error(noTargetHint(port));

  let lastError: unknown;
  for (const { source, target } of ranked) {
    let client: CDP.Client | null = null;
    try {
      client = await withTimeout(
        CDP({ host, port, target }),
        `connecting to the ${source} target`
      );
      return await fn(client, source);
    } catch (err) {
      lastError = err;
    } finally {
      if (client) {
        try {
          await client.close();
        } catch {
          // ignore
        }
      }
    }
  }
  throw lastError ?? new Error(noTargetHint(port));
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
export async function getSessionToken(port = DEFAULT_PORT): Promise<string> {
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
export async function authenticate(port = DEFAULT_PORT): Promise<{
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
