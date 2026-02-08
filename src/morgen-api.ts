/**
 * Morgen API Client
 *
 * HTTP client for the Morgen REST API (api.morgen.so/v3).
 * Supports two auth modes:
 *   - API key (MORGEN_API_KEY env var) — read-only for integration tasks
 *   - Session token (from CDP auth) — full CRUD including integration tasks
 */

import { loadSession } from "./morgen-cdp";

const BASE_URL = "https://api.morgen.so/v3";

export class MorgenApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown
  ) {
    super(message);
    this.name = "MorgenApiError";
  }
}

/**
 * Get the best available auth header.
 * Prefers session token (enables integration CRUD) over API key.
 */
async function getAuthHeader(): Promise<string> {
  // Try session token first (use apiToken, not aiToken)
  const session = await loadSession();
  if (session) {
    return `Bearer ${session.apiToken}`;
  }

  // Fall back to API key
  const key = process.env.MORGEN_API_KEY;
  if (!key) {
    throw new Error(
      "No authentication available.\n" +
        "Either run 'morgen auth' (requires Morgen app running) or set MORGEN_API_KEY."
    );
  }
  return `ApiKey ${key}`;
}

export async function morgenFetch<T>(
  path: string,
  options?: {
    method?: "GET" | "POST";
    body?: unknown;
    params?: Record<string, string>;
  }
): Promise<T> {
  const authHeader = await getAuthHeader();
  const method = options?.method ?? "GET";

  let url = `${BASE_URL}${path}`;
  if (options?.params) {
    const searchParams = new URLSearchParams(options.params);
    url += `?${searchParams.toString()}`;
  }

  const fetchOptions: RequestInit = {
    method,
    headers: {
      Accept: "application/json",
      Authorization: authHeader,
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  };

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }

    if (response.status === 401) {
      throw new MorgenApiError(
        "Authentication failed. Run 'morgen auth' or check MORGEN_API_KEY.",
        401,
        body
      );
    }
    if (response.status === 429) {
      throw new MorgenApiError(
        "Rate limited. Please wait and try again.",
        429,
        body
      );
    }
    throw new MorgenApiError(
      `API error: ${response.status} ${response.statusText}`,
      response.status,
      body
    );
  }

  // 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}
