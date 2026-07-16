/**
 * Morgen CDP Module
 *
 * Connects to Chrome browser (with app.morgen.so open) via Chrome DevTools
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

/** Classify a CDP target as Morgen Electron, Chrome web app, or neither. */
export function classifyTarget(t: any): ConnectionSource | null {
  if (t.type !== "page") return null;
  // The desktop app loads morgen://./app.html; some builds surface the bare
  // app.html URL instead, so accept either as Electron.
  if (t.url?.startsWith("morgen://") || t.url?.includes("app.html")) return "electron";
  if (t.url?.includes("morgen.so")) return "chrome";
  return null;
}

/**
 * Pick the best Morgen target: Electron first (richer credentials via the
 * electronAPI bridge), else the web app. Shared by the session and Firebase
 * credential paths so both honour the same preference order.
 */
export function pickTarget<T>(targets: T[]): { source: ConnectionSource; target: T } | null {
  for (const source of ["electron", "chrome"] as const) {
    const target = targets.find((t) => classifyTarget(t) === source);
    if (target) return { source, target };
  }
  return null;
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
    `  Web app:     open https://app.morgen.so in a browser started with --remote-debugging-port=${port}`
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
 * Connect to Morgen via CDP. Finds the morgen.so tab in Chrome or the Electron app.
 * Returns the connection source and CDP client.
 */
async function connectToMorgen(port: number): Promise<{ source: ConnectionSource; client: CDP.Client }> {
  const host = getCDPHost();
  const targets = await CDP.List({ host, port });

  const picked = pickTarget(targets);
  if (!picked) throw new Error(noTargetHint(port));

  const client = await CDP({ host, port, target: picked.target });
  return { source: picked.source, client };
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
  const result = await Runtime.evaluate({
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
  });

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
  const conn = await connectToMorgen(port);
  try {
    const creds = await extractCredentialsFromClient(conn.client);
    const session = await exchangeForSession(creds.refreshToken, creds.deviceId);
    session.source = conn.source;
    await saveSession(session);
    return session.token;
  } finally {
    await conn.client.close();
  }
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
  const conn = await connectToMorgen(port);
  try {
    const creds = await extractCredentialsFromClient(conn.client);
    const session = await exchangeForSession(creds.refreshToken, creds.deviceId);
    session.source = conn.source;
    await saveSession(session);

    // Get email from the same connection
    const { Runtime } = conn.client;
    const result = await Runtime.evaluate({
      expression: `localStorage.getItem("morgen-email") || "unknown"`,
      returnByValue: true,
    });
    const email = result.result.value;

    return { email, expiresAt: session.expiresAt, source: conn.source };
  } finally {
    await conn.client.close();
  }
}
