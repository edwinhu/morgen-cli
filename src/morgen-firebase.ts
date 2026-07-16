/**
 * Morgen Firebase Module
 *
 * Open Invites / scheduling links are NOT a REST resource on api.morgen.so — they live as
 * documents in the user's Firestore subcollection (`users/{uid}/schedulingLinks`) in the
 * Firebase project `morgen-d34db`. Writing one therefore needs a Firebase ID token, which is a
 * different credential from the api.morgen.so apiToken the rest of the CLI uses.
 *
 * Flow:
 *   1. Grab {uid, refreshToken, apiKey} from the Morgen app's IndexedDB once (via CDP).
 *   2. Cache it, then mint fresh Firebase ID tokens app-independently via the Secure Token API.
 *
 * See docs/investigations/2026-06-10_open-invites.md for the full reverse-engineering.
 */

import CDP from "chrome-remote-interface";
import { resolve } from "path";
import { homedir } from "os";
import { pickTarget, noTargetHint, withTimeout } from "./morgen-cdp";

const DEFAULT_PORT = parseInt(process.env.CDP_PORT || "9253", 10);
const SECURETOKEN_URL = "https://securetoken.googleapis.com/v1/token";

/** Firebase project the Morgen app syncs against (from the app bundle). */
export const FIREBASE_PROJECT_ID = "morgen-d34db";

export interface FirebaseCredentials {
  uid: string;
  refreshToken: string;
  apiKey: string;
}

export interface FirebaseSession extends FirebaseCredentials {
  idToken: string;
  expiresAt: number; // Unix ms
}

function getCDPHost(): string {
  return process.env.CDP_HOST || process.env.HOST_IP || "localhost";
}

/** Resolve the Firebase credential cache path at call time (tests redirect via env). */
function getFirebaseFile(): string {
  return (
    process.env.MORGEN_FIREBASE_FILE ||
    resolve(homedir(), ".config", "morgen-cli", "firebase.json")
  );
}

/** Find the Morgen Electron/Chrome target and read Firebase auth state from IndexedDB. */
async function extractFromApp(port: number): Promise<FirebaseCredentials> {
  const host = getCDPHost();
  const targets = await CDP.List({ host, port });
  // Share morgen-cdp's picker so the Firebase path honours the same
  // Electron-then-web preference; it previously took whichever target matched
  // first, which could land on the web app while the desktop app was running.
  const picked = pickTarget(targets);
  if (!picked) throw new Error(noTargetHint(port));

  const client = await CDP({ host, port, target: picked.target });
  try {
    const { Runtime } = client;
    const result = await withTimeout(Runtime.evaluate({
      // firebase:authUser:<apiKey>:[DEFAULT] holds {uid, stsTokenManager:{refreshToken}, apiKey}
      expression: `
        (async () => {
          return await new Promise((res) => {
            const open = indexedDB.open("firebaseLocalStorageDb");
            open.onerror = () => res(JSON.stringify({ error: "indexeddb open failed" }));
            open.onsuccess = () => {
              try {
                const store = open.result
                  .transaction("firebaseLocalStorage", "readonly")
                  .objectStore("firebaseLocalStorage");
                const all = store.getAll();
                all.onsuccess = () => {
                  const row = (all.result || []).find(
                    (r) => r && r.value && r.value.stsTokenManager
                  );
                  if (!row) return res(JSON.stringify({ error: "no firebase auth user" }));
                  const v = row.value;
                  res(JSON.stringify({
                    uid: v.uid,
                    refreshToken: v.stsTokenManager.refreshToken,
                    apiKey: v.apiKey,
                  }));
                };
                all.onerror = () => res(JSON.stringify({ error: "getAll failed" }));
              } catch (e) {
                res(JSON.stringify({ error: String(e) }));
              }
            };
          });
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    }), "reading Firebase auth state from IndexedDB");

    const creds = JSON.parse(result.result.value as string);
    if (creds.error) {
      throw new Error(
        `Could not read Firebase auth from Morgen app: ${creds.error}. ` +
          "Log in to the Morgen app once, then retry."
      );
    }
    if (!creds.uid || !creds.refreshToken || !creds.apiKey) {
      throw new Error("Incomplete Firebase credentials in Morgen app.");
    }
    return creds as FirebaseCredentials;
  } finally {
    await client.close();
  }
}

/** Exchange a Firebase refresh token for a fresh ID token (no app/CDP required). */
async function exchangeIdToken(creds: FirebaseCredentials): Promise<FirebaseSession> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
  });
  const resp = await fetch(`${SECURETOKEN_URL}?key=${creds.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`Firebase token refresh failed (${resp.status}): ${err.slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    id_token: string;
    refresh_token: string;
    expires_in: string;
    user_id: string;
  };
  return {
    uid: data.user_id || creds.uid,
    refreshToken: data.refresh_token || creds.refreshToken,
    apiKey: creds.apiKey,
    idToken: data.id_token,
    expiresAt: Date.now() + parseInt(data.expires_in || "3600", 10) * 1000,
  };
}

async function saveFirebaseSession(session: FirebaseSession): Promise<void> {
  const path = getFirebaseFile();
  const { dirname } = await import("path");
  await Bun.write(resolve(dirname(path), ".gitkeep"), "");
  await Bun.write(path, JSON.stringify(session, null, 2));
}

async function loadFirebaseSession(): Promise<FirebaseSession | null> {
  try {
    const file = Bun.file(getFirebaseFile());
    if (!(await file.exists())) return null;
    return (await file.json()) as FirebaseSession;
  } catch {
    return null;
  }
}

/**
 * Get a valid Firebase session (id token + uid). Uses the cached refresh token to mint a fresh
 * id token when the cached one is near expiry; only falls back to CDP extraction when there is
 * no cached credential at all.
 */
export async function getFirebaseSession(port = DEFAULT_PORT): Promise<FirebaseSession> {
  const cached = await loadFirebaseSession();
  if (cached?.refreshToken) {
    // Reuse a still-valid id token (5-min buffer); otherwise refresh app-independently.
    if (cached.idToken && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
      return cached;
    }
    try {
      const refreshed = await exchangeIdToken(cached);
      await saveFirebaseSession(refreshed);
      return refreshed;
    } catch {
      // Refresh token rejected — fall through to CDP re-extraction.
    }
  }

  const creds = await extractFromApp(port);
  const session = await exchangeIdToken(creds);
  await saveFirebaseSession(session);
  return session;
}

/** Force re-extraction of Firebase credentials from the running app (for `auth`). */
export async function authenticateFirebase(port = DEFAULT_PORT): Promise<FirebaseSession> {
  const creds = await extractFromApp(port);
  const session = await exchangeIdToken(creds);
  await saveFirebaseSession(session);
  return session;
}
