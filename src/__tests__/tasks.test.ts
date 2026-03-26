import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  listTasks,
  listAllTasks,
  streamTasks,
  listIntegrationAccounts,
  decodeIntegrationId,
  getTask,
  createTask,
  updateTask,
  closeTask,
  reopenTask,
  deleteTask,
  moveTask,
  resetAccountsCache,
} from "../tasks";

describe("tasks module exports", () => {
  it("exports all expected functions", () => {
    expect(typeof listTasks).toBe("function");
    expect(typeof listAllTasks).toBe("function");
    expect(typeof streamTasks).toBe("function");
    expect(typeof listIntegrationAccounts).toBe("function");
    expect(typeof decodeIntegrationId).toBe("function");
    expect(typeof getTask).toBe("function");
    expect(typeof createTask).toBe("function");
    expect(typeof updateTask).toBe("function");
    expect(typeof closeTask).toBe("function");
    expect(typeof reopenTask).toBe("function");
    expect(typeof deleteTask).toBe("function");
    expect(typeof moveTask).toBe("function");
  });
});

describe("decodeIntegrationId", () => {
  it("decodes a base64 integration task ID", () => {
    const payload = { aid: "acct-123", t: "task-456", tl: "list-789" };
    const encoded = btoa(JSON.stringify(payload));
    const decoded = decodeIntegrationId(encoded);
    expect(decoded).toEqual(payload);
  });

  it("returns null for a plain Morgen task ID", () => {
    expect(decodeIntegrationId("simple-task-id-abc")).toBeNull();
  });

  it("returns null for base64 that doesn't have aid/t/tl", () => {
    const encoded = btoa(JSON.stringify({ foo: "bar" }));
    expect(decodeIntegrationId(encoded)).toBeNull();
  });
});

describe("tasks module behavior", () => {
  const originalEnv = process.env.MORGEN_API_KEY;
  const originalFetch = globalThis.fetch;
  let lastRequest: { url: string; init?: RequestInit } | null = null;

  beforeEach(() => {
    process.env.MORGEN_API_KEY = "test-api-key-12345";
    lastRequest = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv) {
      process.env.MORGEN_API_KEY = originalEnv;
    } else {
      delete process.env.MORGEN_API_KEY;
    }
  });

  function mockFetch(responseBody: unknown, status = 200) {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      lastRequest = { url: String(input), init };
      return new Response(JSON.stringify(responseBody), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  function mockFetchNoContent() {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      lastRequest = { url: String(input), init };
      return new Response(null, { status: 204 });
    }) as typeof fetch;
  }

  it("listTasks calls the correct URL path and passes params", async () => {
    mockFetch({ data: { tasks: [{ id: "t1", title: "Test task" }], labelDefs: [] } });

    const tasks = await listTasks({ limit: 10 });

    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.url).toContain("/v3/tasks/list");
    expect(lastRequest!.url).toContain("limit=10");
    expect(tasks).toEqual([{ id: "t1", title: "Test task" }]);
  });

  it("createTask POSTs to /tasks/create and returns the task ID", async () => {
    mockFetch({ data: { id: "new-task-123" } });

    const id = await createTask({ title: "New task" });

    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.url).toContain("/v3/tasks/create");
    expect(lastRequest!.init?.method).toBe("POST");
    const body = JSON.parse(lastRequest!.init?.body as string);
    expect(body.title).toBe("New task");
    expect(id).toBe("new-task-123");
  });

  it("closeTask sends correct body with id", async () => {
    mockFetchNoContent();

    await closeTask("task-abc");

    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.url).toContain("/v3/tasks/close");
    expect(lastRequest!.init?.method).toBe("POST");
    const body = JSON.parse(lastRequest!.init?.body as string);
    expect(body.id).toBe("task-abc");
  });

  it("listTasks passes accountId param when provided", async () => {
    mockFetch({ data: { tasks: [{ id: "int-1", title: "Integration task" }], labelDefs: [] } });

    const tasks = await listTasks({ accountId: "acct-123" });

    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.url).toContain("/v3/tasks/list");
    expect(lastRequest!.url).toContain("accountId=acct-123");
    expect(tasks).toEqual([{ id: "int-1", title: "Integration task" }]);
  });

  it("listIntegrationAccounts filters to task accounts", async () => {
    mockFetch({
      data: {
        accounts: [
          { id: "a1", integrationId: "googleTasks", integrationGroups: ["tasks"] },
          { id: "a2", integrationId: "google", integrationGroups: ["calendars"] },
          { id: "a3", integrationId: "microsoftToDo", integrationGroups: ["tasks"] },
        ],
      },
    });

    const accounts = await listIntegrationAccounts();

    expect(accounts).toHaveLength(2);
    expect(accounts[0].id).toBe("a1");
    expect(accounts[1].id).toBe("a3");
  });

  it("listIntegrationAccounts includes accounts when integrationGroups is absent", async () => {
    // Real API may not return integrationGroups; default to including the account
    mockFetch({
      data: {
        accounts: [
          { id: "a1", integrationId: "googleTasks" },
          { id: "a2", integrationId: "google", integrationGroups: ["calendars"] },
          { id: "a3", integrationId: "microsoftToDo" },
        ],
      },
    });

    const accounts = await listIntegrationAccounts();

    expect(accounts).toHaveLength(2);
    expect(accounts[0].id).toBe("a1");
    expect(accounts[1].id).toBe("a3");
  });

  it("propagates API errors as MorgenApiError", async () => {
    const { MorgenApiError } = await import("../morgen-api");

    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await listTasks();
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(MorgenApiError);
      if (err instanceof MorgenApiError) {
        expect(err.status).toBe(404);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Integration task close / reopen — MS Todo and Google Tasks
// ---------------------------------------------------------------------------

describe("integration task close/reopen", () => {
  const originalEnv = process.env.MORGEN_API_KEY;
  const originalFetch = globalThis.fetch;

  /** Encode a compound Morgen integration task ID */
  function makeCompoundId(aid: string, t: string, tl: string): string {
    return btoa(JSON.stringify({ aid, t, tl }));
  }

  /**
   * Build a fetch mock that dispatches by URL substring.
   * Captures the last close/reopen request body for inspection.
   */
  function mockDispatch(
    accounts: Array<{ id: string; integrationId: string }>,
    onCloseReopen: (body: Record<string, unknown>) => void
  ) {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/integrations/accounts/list")) {
        return new Response(
          JSON.stringify({ data: { accounts } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/tasks/close") || url.includes("/tasks/reopen")) {
        onCloseReopen(JSON.parse(init?.body as string));
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    }) as typeof fetch;
  }

  beforeEach(() => {
    process.env.MORGEN_API_KEY = "test-api-key-12345";
    resetAccountsCache(); // prevent stale account cache from leaking between tests
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAccountsCache();
    if (originalEnv) {
      process.env.MORGEN_API_KEY = originalEnv;
    } else {
      delete process.env.MORGEN_API_KEY;
    }
  });

  it("closeTask for MS Todo sends the full compound Morgen ID", async () => {
    const aid = "morgen-acct-mstodo";
    const nativeTaskId = "AAMkAGQxOTk123";   // Microsoft Graph task ID
    const nativeListId = "AAMkAGQyList456";  // Microsoft Graph task list ID
    const compoundId = makeCompoundId(aid, nativeTaskId, nativeListId);
    let captured: Record<string, unknown> = {};

    mockDispatch(
      [{ id: aid, integrationId: "microsoftToDo" }],
      (body) => { captured = body; }
    );

    await closeTask(compoundId);

    // Must send the full compound ID — server decodes it to get both task ID and list ID
    expect(captured.id).toBe(compoundId);
    expect(captured.taskListId).toBeUndefined();
    expect(captured.integrationId).toBe("microsoftToDo");
    expect(captured.accountId).toBe(aid);
  });

  it("closeTask for Google Tasks sends the full compound Morgen ID", async () => {
    const aid = "morgen-acct-google";
    const nativeTaskId = "MDEyMzQ1Njc4OQ";    // Google Tasks task ID
    const nativeListId = "MDEyMzQ1Njc4List";  // Google Tasks tasklist ID
    const compoundId = makeCompoundId(aid, nativeTaskId, nativeListId);
    let captured: Record<string, unknown> = {};

    mockDispatch(
      [{ id: aid, integrationId: "googleTasks" }],
      (body) => { captured = body; }
    );

    await closeTask(compoundId);

    expect(captured.id).toBe(compoundId);
    expect(captured.taskListId).toBeUndefined();
    expect(captured.integrationId).toBe("googleTasks");
    expect(captured.accountId).toBe(aid);
  });

  it("reopenTask for MS Todo sends the full compound Morgen ID", async () => {
    const aid = "morgen-acct-mstodo";
    const nativeTaskId = "AAMkAGQxReopen";
    const nativeListId = "AAMkAGQyReopenList";
    const compoundId = makeCompoundId(aid, nativeTaskId, nativeListId);
    let captured: Record<string, unknown> = {};

    mockDispatch(
      [{ id: aid, integrationId: "microsoftToDo" }],
      (body) => { captured = body; }
    );

    await reopenTask(compoundId);

    expect(captured.id).toBe(compoundId);
    expect(captured.taskListId).toBeUndefined();
    expect(captured.integrationId).toBe("microsoftToDo");
    expect(captured.accountId).toBe(aid);
  });

  it("closeTask for native Morgen task sends id directly without taskListId", async () => {
    // Plain non-base64 task IDs are native Morgen tasks — no integration routing needed
    let captured: Record<string, unknown> = {};

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(init?.body as string);
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await closeTask("native-task-id-xyz");

    expect(captured.id).toBe("native-task-id-xyz");
    expect(captured.taskListId).toBeUndefined();
    expect(captured.integrationId).toBeUndefined();
    expect(captured.accountId).toBeUndefined();
  });

  it("closeTask throws a clear error when integrationId cannot be resolved", async () => {
    const compoundId = makeCompoundId("unknown-acct", "task-t", "list-tl");

    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("/integrations/accounts/list")) {
        return new Response(JSON.stringify({ data: { accounts: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${String(input)}`);
    }) as typeof fetch;

    await expect(closeTask(compoundId)).rejects.toThrow("Cannot resolve integration type");
  });
});
