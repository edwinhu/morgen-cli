/**
 * Recording stub for the Morgen v3 REST API.
 *
 * Point `MORGEN_API_BASE_URL` at `stub.url` (in-process, or in the env of a
 * spawned `morgen` binary) and every request the code under test issues is
 * captured in `stub.requests` and answered with a canned v3 payload. Assertions
 * are made against the HTTP request that actually left the client — method,
 * pathname, query string, parsed JSON body, headers — not against a mocked
 * function call.
 *
 * Never makes an outbound request; it only listens on an ephemeral port.
 */

export interface RecordedRequest {
  method: string;
  /** Full request path as received, e.g. "/v3/events/create". */
  pathname: string;
  /** API path with the "/v3" prefix stripped, e.g. "/events/create". */
  path: string;
  /** Full request URL including query string. */
  url: string;
  /** Query string parameters, flattened. */
  query: Record<string, string>;
  /** Parsed JSON body, or undefined when the request carried no body. */
  body: unknown;
  /** Request headers, lowercased keys. */
  headers: Record<string, string>;
}

export interface StubApiOptions {
  /** Payload for GET /calendars/list. */
  calendars?: unknown[];
  /** Payload for GET /events/list. */
  events?: unknown[];
  /** Event id returned by POST /events/create. */
  createdEventId?: string;
}

export interface StubApi {
  /** Base URL to hand to MORGEN_API_BASE_URL, e.g. "http://127.0.0.1:1234/v3". */
  url: string;
  /** Every request received, in arrival order. */
  requests: RecordedRequest[];
  /** Requests whose API path matches, e.g. requestsFor("/events/delete"). */
  requestsFor(path: string): RecordedRequest[];
  close(): void;
}

const DEFAULT_CALENDARS = [
  {
    "@type": "Calendar",
    id: "cal-stub",
    accountId: "acc-stub",
    integrationId: "google",
    name: "Stub",
    myRights: { mayRead: true, mayWrite: true, mayAdmin: false, mayRSVP: true },
  },
];

export function startStubApi(options: StubApiOptions = {}): StubApi {
  const requests: RecordedRequest[] = [];
  const calendars = options.calendars ?? DEFAULT_CALENDARS;
  const events = options.events ?? [];
  const createdEventId = options.createdEventId ?? "stub-event-id";

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const path = pathname.startsWith("/v3")
        ? pathname.slice("/v3".length)
        : pathname;

      const raw = await req.text();
      let body: unknown;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }

      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      requests.push({
        method: req.method,
        pathname,
        path,
        url: req.url,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
        headers,
      });

      switch (path) {
        case "/calendars/list":
          return json({ data: { calendars } });
        case "/events/list":
          return json({ data: { events } });
        case "/events/create":
          return json({ data: { event: { id: createdEventId } } });
        case "/events/update":
          return json({ data: {} });
        case "/events/delete":
          return new Response(null, { status: 204 });
        default:
          return json({ error: `stub-api: unhandled path ${path}` }, 404);
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/v3`,
    requests,
    requestsFor(p: string) {
      return requests.filter((r) => r.path === p);
    },
    close() {
      server.stop(true);
    },
  };
}
