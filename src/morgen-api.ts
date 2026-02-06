/**
 * Morgen API Client
 *
 * HTTP client for the Morgen REST API (api.morgen.so/v3).
 * Auth via MORGEN_API_KEY environment variable.
 */

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

function getApiKey(): string {
  const key = process.env.MORGEN_API_KEY;
  if (!key) {
    throw new Error(
      "MORGEN_API_KEY environment variable is not set.\n" +
      "Get your API key from https://platform.morgen.so and set it:\n" +
      "  export MORGEN_API_KEY=your_key_here"
    );
  }
  return key;
}

export async function morgenFetch<T>(
  path: string,
  options?: {
    method?: "GET" | "POST";
    body?: unknown;
    params?: Record<string, string>;
  }
): Promise<T> {
  const apiKey = getApiKey();
  const method = options?.method ?? "GET";

  let url = `${BASE_URL}${path}`;
  if (options?.params) {
    const searchParams = new URLSearchParams(options.params);
    url += `?${searchParams.toString()}`;
  }

  const fetchOptions: RequestInit = {
    method,
    headers: {
      "Accept": "application/json",
      "Authorization": `ApiKey ${apiKey}`,
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
        "Invalid API key. Check your MORGEN_API_KEY.",
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
