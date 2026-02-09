/**
 * Morgen CDP Module
 *
 * Connects to the running Morgen Electron app via Chrome DevTools Protocol
 * to extract authentication credentials. The session token enables full
 * integration task CRUD through the Morgen API.
 *
 * Flow:
 *   1. Connect to Morgen's CDP on localhost:9223
 *   2. Read morgen-refresh-token from renderer localStorage
 *   3. Read morgen-device-id from electronAPI.localStorage (main process)
 *   4. Exchange via POST /identity/refresh → session token (1h TTL)
 */

import CDP from "chrome-remote-interface";
import { resolve } from "path";
import { homedir } from "os";

const API_BASE = "https://api.morgen.so";
const DEFAULT_PORT = 9223;
const SESSION_FILE = resolve(homedir(), ".config", "morgen-cli", "session.json");

/**
 * Get CDP host from environment or default to localhost
 */
function getCDPHost(): string {
  return process.env.CDP_HOST || process.env.HOST_IP || "localhost";
}

export interface SessionInfo {
  token: string; // AI gateway token (for ai.cf.morgen.so)
  apiToken: string; // Regular API token (for api.morgen.so)
  refreshToken: string;
  deviceId: string;
  expiresAt: number; // Unix timestamp ms
}

/** Check if Morgen is running with CDP enabled. */
export async function isMorgenRunning(port = DEFAULT_PORT): Promise<boolean> {
  try {
    const host = getCDPHost();
    const targets = await CDP.List({ host, port });
    return targets.some((t: any) => t.title === "Morgen Calendar" || t.url?.includes("morgen"));
  } catch {
    return false;
  }
}

/** Extract refresh token and device ID from running Morgen app. */
async function extractCredentials(port = DEFAULT_PORT): Promise<{
  refreshToken: string;
  deviceId: string;
}> {
  const host = getCDPHost();
  const targets = await CDP.List({ host, port });
  const pageTarget = targets.find((t: any) => t.type === "page");
  if (!pageTarget) throw new Error("Morgen page target not found via CDP");

  const client = await CDP({ host, port, target: pageTarget });
  try {
    const { Runtime } = client;

    const result = await Runtime.evaluate({
      expression: `
        (async () => {
          const refreshToken = localStorage.getItem("morgen-refresh-token");
          const deviceId = await window.electronAPI.localStorage.get("morgen-device-id");
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
  } finally {
    await client.close();
  }
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
 * Get a valid session token. Tries cached session first,
 * then extracts from running Morgen app.
 */
export async function getSessionToken(port = DEFAULT_PORT): Promise<string> {
  // Try cached session
  const cached = await loadSession();
  if (cached) return cached.token;

  // Extract from running Morgen app
  const creds = await extractCredentials(port);
  const session = await exchangeForSession(creds.refreshToken, creds.deviceId);
  await saveSession(session);
  return session.token;
}

/**
 * Authenticate: extract credentials from running Morgen app and save session.
 * Returns account info for display.
 */
export async function authenticate(port = DEFAULT_PORT): Promise<{
  email: string;
  expiresAt: number;
}> {
  if (!(await isMorgenRunning(port))) {
    throw new Error(
      "Morgen is not running with CDP enabled.\n" +
      "Start Morgen with: /Applications/Morgen.app/Contents/MacOS/Morgen --remote-debugging-port=9223"
    );
  }

  const creds = await extractCredentials(port);
  const session = await exchangeForSession(creds.refreshToken, creds.deviceId);
  await saveSession(session);

  // Get email from Morgen app
  const host = getCDPHost();
  const targets = await CDP.List({ host, port });
  const pageTarget = targets.find((t: any) => t.type === "page");
  let email = "unknown";
  if (pageTarget) {
    const client = await CDP({ host, port, target: pageTarget });
    try {
      const { Runtime } = client;
      const result = await Runtime.evaluate({
        expression: `localStorage.getItem("morgen-email") || "unknown"`,
        returnByValue: true,
      });
      email = result.result.value;
    } finally {
      await client.close();
    }
  }

  return { email, expiresAt: session.expiresAt };
}
