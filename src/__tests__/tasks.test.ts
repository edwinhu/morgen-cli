import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  closeTask,
  reopenTask,
  deleteTask,
  moveTask,
} from "../tasks";

describe("tasks module exports", () => {
  it("exports all expected functions", () => {
    expect(typeof listTasks).toBe("function");
    expect(typeof getTask).toBe("function");
    expect(typeof createTask).toBe("function");
    expect(typeof updateTask).toBe("function");
    expect(typeof closeTask).toBe("function");
    expect(typeof reopenTask).toBe("function");
    expect(typeof deleteTask).toBe("function");
    expect(typeof moveTask).toBe("function");
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
