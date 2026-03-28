/**
 * Morgen CDP Module
 *
 * Connects to the running Morgen Electron app or Chrome browser via Chrome
 * DevTools Protocol to extract authentication credentials. The session token
 * enables full integration task CRUD through the Morgen API.
 *
 * Auth discovery order:
 *   1. Morgen Electron app (title "Morgen Calendar")
 *   2. Chrome browser with app.morgen.so open
 *
 * Flow:
 *   1. Connect via CDP to Electron or Chrome
 *   2. Read morgen-refresh-token from renderer localStorage
 *   3. Read morgen-device-id from electronAPI.localStorage (Electron) or localStorage (Chrome)
 *   4. Exchange via POST /identity/refresh → session token (1h TTL)
 */

import CDP from "chrome-remote-interface";
import { resolve } from "path";
import { homedir } from "os";

const API_BASE = "https://api.morgen.so";
const DEFAULT_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const SESSION_FILE = resolve(homedir(), ".config", "morgen-cli", "session.json");

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

/** Check if Morgen is reachable via CDP. Returns connection source or false. */
export async function isMorgenRunning(port = DEFAULT_PORT): Promise<ConnectionSource | false> {
  try {
    const host = getCDPHost();
    const targets = await CDP.List({ host, port });
    if (targets.some((t: any) => t.title === "Morgen Calendar")) return "electron";
    if (targets.some((t: any) => t.type === "page" && t.url?.includes("morgen.so"))) return "chrome";
    return false;
  } catch {
    return false;
  }
}

/**
 * Connect to Morgen via CDP. Tries Electron app first, then Chrome browser.
 * Returns the connection source and CDP client.
 */
async function connectToMorgen(port: number): Promise<{ source: ConnectionSource; client: CDP.Client }> {
  const host = getCDPHost();
  const targets = await CDP.List({ host, port });

  // Try Electron app first (specific window title)
  const electronTarget = targets.find((t: any) =>
    t.type === "page" && t.title === "Morgen Calendar"
  );
  if (electronTarget) {
    const client = await CDP({ host, port, target: electronTarget });
    return { source: "electron", client };
  }

  // Fall back to Chrome (any page with morgen.so URL)
  const chromeTarget = targets.find((t: any) =>
    t.type === "page" && t.url?.includes("morgen.so")
  );
  if (chromeTarget) {
    const client = await CDP({ host, port, target: chromeTarget });
    return { source: "chrome", client };
  }

  throw new Error(
    `No Morgen target found on port ${port}.\n` +
    "Start one of:\n" +
    "  Chrome:   nanoclaw-chrome start\n" +
    "  Electron: /Applications/Morgen.app/Contents/MacOS/Morgen --remote-debugging-port=" + port
  );
}

/** Extract refresh token and device ID from an existing CDP client. */
async function extractCredentialsFromClient(client: CDP.Client): Promise<{
  refreshToken: string;
  deviceId: string;
}> {
  const { Runtime } = client;

  const result = await Runtime.evaluate({
    expression: `
      (async () => {
        const refreshToken = localStorage.getItem("morgen-refresh-token");
        const deviceId = window.electronAPI
          ? await window.electronAPI.localStorage.get("morgen-device-id")
          : localStorage.getItem("morgen-device-id");
        return JSON.stringify({ refreshToken, deviceId });
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
  });

  const creds = JSON.parse(result.result.value);
  if (!creds.refreshToken) throw new Error("No morgen-refresh-token found in Morgen app");
  if (!creds.deviceId) throw new Error("No morgen-device-id found in Morgen app");

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
  const dir = resolve(homedir(), ".config", "morgen-cli");
  await Bun.write(resolve(dir, ".gitkeep"), ""); // ensure dir exists
  await Bun.write(SESSION_FILE, JSON.stringify(session, null, 2));
}

/** Load session from disk. Returns null if not found or expired. */
export async function loadSession(): Promise<SessionInfo | null> {
  try {
    const file = Bun.file(SESSION_FILE);
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
  const file = Bun.file(SESSION_FILE);
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
