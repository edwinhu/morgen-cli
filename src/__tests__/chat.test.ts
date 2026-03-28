import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type {
  ChatMessage,
  ChatMessageToolCall,
  ChatToolCall,
  ChatCompletionChunkDelta,
  ChatCompletionChunk,
  ChatResponse,
} from "../types";

// Mock morgen-cdp BEFORE importing chat module
let mockLoadSessionResult: { token: string; apiToken: string; refreshToken: string; deviceId: string; expiresAt: number } | null = null;

mock.module("../morgen-cdp", () => ({
  loadSession: () => Promise.resolve(mockLoadSessionResult),
  saveSession: async () => {},
  isMorgenRunning: async () => false,
  authenticate: async () => ({ email: "", expiresAt: 0, source: "electron" }),
  refreshSession: async () => { throw new Error("no stored session"); },
  getSessionToken: async () => "",
}));

// Import chat functions after mock is set up
const { parseSSEStream, sendChat } = await import("../chat");

/** Helper: create a ReadableStream that emits SSE-formatted text chunks. */
function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

// ─── Existing type-level tests ───

describe("Chat types", () => {
  it("ChatMessage supports all valid roles", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "tool", content: '{"result": 42}' },
    ];

    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[2].role).toBe("assistant");
    expect(messages[3].role).toBe("tool");
  });

  it("ChatToolCall has id, name and arguments", () => {
    const toolCall: ChatToolCall = {
      id: "call_123",
      name: "get_weather",
      arguments: '{"city": "San Francisco"}',
    };

    expect(toolCall.id).toBe("call_123");
    expect(toolCall.name).toBe("get_weather");
    expect(toolCall.arguments).toBe('{"city": "San Francisco"}');
  });

  it("ChatCompletionChunkDelta supports all optional fields", () => {
    const deltaMinimal: ChatCompletionChunkDelta = {};
    expect(deltaMinimal.role).toBeUndefined();
    expect(deltaMinimal.content).toBeUndefined();
    expect(deltaMinimal.tool_calls).toBeUndefined();

    const deltaFull: ChatCompletionChunkDelta = {
      role: "assistant",
      content: "Hello",
      tool_calls: [
        {
          id: "call_123",
          index: 0,
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"NYC"}' },
        },
      ],
    };

    expect(deltaFull.role).toBe("assistant");
    expect(deltaFull.content).toBe("Hello");
    expect(deltaFull.tool_calls).toHaveLength(1);
    expect(deltaFull.tool_calls![0].function.name).toBe("get_weather");
  });

  it("ChatCompletionChunk has required fields and optional usage", () => {
    const chunk: ChatCompletionChunk = {
      id: "chatcmpl-abc123",
      model: "gpt-4",
      choices: [
        {
          index: 0,
          delta: { content: "Hello" },
          finish_reason: null,
        },
      ],
    };

    expect(chunk.id).toBe("chatcmpl-abc123");
    expect(chunk.model).toBe("gpt-4");
    expect(chunk.choices).toHaveLength(1);
    expect(chunk.choices[0].finish_reason).toBeNull();
    expect(chunk.usage).toBeUndefined();

    const chunkWithUsage: ChatCompletionChunk = {
      id: "chatcmpl-xyz",
      model: "gpt-4",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    };

    expect(chunkWithUsage.usage).toBeDefined();
    expect(chunkWithUsage.usage!.total_tokens).toBe(30);
  });

  it("ChatResponse has text and optional fields", () => {
    const minimal: ChatResponse = {
      text: "Hello, world!",
    };

    expect(minimal.text).toBe("Hello, world!");
    expect(minimal.toolCalls).toBeUndefined();
    expect(minimal.usage).toBeUndefined();

    const full: ChatResponse = {
      text: "",
      toolCalls: [
        { id: "call_1", name: "search", arguments: '{"query":"test"}' },
      ],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 100,
      },
    };

    expect(full.toolCalls).toHaveLength(1);
    expect(full.usage!.prompt_tokens).toBe(50);
  });
});

// ─── parseSSEStream tests ───

describe("parseSSEStream", () => {
  it("parses a single SSE data line into a ChatCompletionChunk", async () => {
    const chunk: ChatCompletionChunk = {
      id: "chatcmpl-001",
      model: "anthropic/claude-haiku-4.5",
      choices: [
        {
          index: 0,
          delta: { content: "Hello" },
          finish_reason: null,
        },
      ],
    };

    const stream = createSSEStream([
      `data: ${JSON.stringify(chunk)}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const results: ChatCompletionChunk[] = [];
    for await (const parsed of parseSSEStream(stream)) {
      results.push(parsed);
    }

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("chatcmpl-001");
    expect(results[0].choices[0].delta.content).toBe("Hello");
  });

  it("parses multiple SSE chunks from a single data buffer", async () => {
    const chunk1: ChatCompletionChunk = {
      id: "chatcmpl-002",
      model: "test",
      choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
    };
    const chunk2: ChatCompletionChunk = {
      id: "chatcmpl-002",
      model: "test",
      choices: [{ index: 0, delta: { content: " there" }, finish_reason: null }],
    };

    // Both chunks arrive in one buffer
    const stream = createSSEStream([
      `data: ${JSON.stringify(chunk1)}\n\ndata: ${JSON.stringify(chunk2)}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const results: ChatCompletionChunk[] = [];
    for await (const parsed of parseSSEStream(stream)) {
      results.push(parsed);
    }

    expect(results).toHaveLength(2);
    expect(results[0].choices[0].delta.content).toBe("Hi");
    expect(results[1].choices[0].delta.content).toBe(" there");
  });

  it("handles chunks split across multiple buffers", async () => {
    const chunkJson = JSON.stringify({
      id: "chatcmpl-003",
      model: "test",
      choices: [{ index: 0, delta: { content: "split" }, finish_reason: null }],
    });

    // Split the SSE line across two buffers
    const fullLine = `data: ${chunkJson}\n\n`;
    const mid = Math.floor(fullLine.length / 2);

    const stream = createSSEStream([
      fullLine.slice(0, mid),
      fullLine.slice(mid),
      "data: [DONE]\n\n",
    ]);

    const results: ChatCompletionChunk[] = [];
    for await (const parsed of parseSSEStream(stream)) {
      results.push(parsed);
    }

    expect(results).toHaveLength(1);
    expect(results[0].choices[0].delta.content).toBe("split");
  });

  it("ignores empty lines and non-data lines", async () => {
    const chunk: ChatCompletionChunk = {
      id: "chatcmpl-004",
      model: "test",
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
    };

    const stream = createSSEStream([
      ": this is a comment\n\n",
      "\n",
      `data: ${JSON.stringify(chunk)}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const results: ChatCompletionChunk[] = [];
    for await (const parsed of parseSSEStream(stream)) {
      results.push(parsed);
    }

    expect(results).toHaveLength(1);
    expect(results[0].choices[0].delta.content).toBe("ok");
  });

  it("handles chunk with usage info (final chunk)", async () => {
    const chunk: ChatCompletionChunk = {
      id: "chatcmpl-005",
      model: "test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const stream = createSSEStream([
      `data: ${JSON.stringify(chunk)}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const results: ChatCompletionChunk[] = [];
    for await (const parsed of parseSSEStream(stream)) {
      results.push(parsed);
    }

    expect(results).toHaveLength(1);
    expect(results[0].usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(results[0].choices[0].finish_reason).toBe("stop");
  });
});

// ─── sendChat tests ───

describe("sendChat", () => {
  const originalFetch = globalThis.fetch;
  let lastRequest: { url: string; init?: RequestInit } | null = null;

  beforeEach(() => {
    lastRequest = null;
    // Default: session available
    mockLoadSessionResult = {
      token: "test-jwt-token",
      apiToken: "test-api-token",
      refreshToken: "test-refresh",
      deviceId: "test-device",
      expiresAt: Date.now() + 3600000,
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockSSEFetch(sseChunks: string[], status = 200) {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      lastRequest = { url: String(input), init };
      const stream = createSSEStream(sseChunks);
      return new Response(stream, {
        status,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;
  }

  it("throws when no session token is available", async () => {
    mockLoadSessionResult = null;
    mockSSEFetch([]); // won't be reached

    await expect(sendChat("hello")).rejects.toThrow("No active Morgen session");
  });

  it("sends correct request to the chat endpoint", async () => {
    const chunk1 = {
      id: "c1",
      model: "anthropic/claude-haiku-4.5",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    };
    const chunk2 = {
      id: "c1",
      model: "anthropic/claude-haiku-4.5",
      choices: [{ index: 0, delta: { content: "Hello!" }, finish_reason: null }],
    };
    const chunk3 = {
      id: "c1",
      model: "anthropic/claude-haiku-4.5",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };

    mockSSEFetch([
      `data: ${JSON.stringify(chunk1)}\n\n`,
      `data: ${JSON.stringify(chunk2)}\n\n`,
      `data: ${JSON.stringify(chunk3)}\n\n`,
      "data: [DONE]\n\n",
    ]);

    await sendChat("test prompt");

    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.url).toBe(
      "https://ai.cf.morgen.so/openrouter/chat/completions"
    );
    expect(lastRequest!.init?.method).toBe("POST");

    const headers = lastRequest!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-jwt-token");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(lastRequest!.init?.body as string);
    expect(body.model).toBe("anthropic/claude-haiku-4.5");
    expect(body.stream).toBe(true);
    // First message is system prompt, second is user message
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("calendar");
    expect(body.messages[1]).toEqual({ role: "user", content: "test prompt" });
  });

  it("assembles text from content deltas and returns ChatResponse", async () => {
    const chunks = [
      {
        id: "c2",
        model: "test",
        choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
      },
      {
        id: "c2",
        model: "test",
        choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
      },
      {
        id: "c2",
        model: "test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ];

    mockSSEFetch([
      ...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`),
      "data: [DONE]\n\n",
    ]);

    const result: ChatResponse = await sendChat("hi");

    expect(result.text).toBe("Hello world");
    expect(result.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
    });
  });

  it("calls onToken callback for each content delta", async () => {
    const chunks = [
      {
        id: "c3",
        model: "test",
        choices: [{ index: 0, delta: { content: "A" }, finish_reason: null }],
      },
      {
        id: "c3",
        model: "test",
        choices: [{ index: 0, delta: { content: "B" }, finish_reason: null }],
      },
      {
        id: "c3",
        model: "test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ];

    mockSSEFetch([
      ...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`),
      "data: [DONE]\n\n",
    ]);

    const tokens: string[] = [];
    await sendChat("hi", { onToken: (t) => tokens.push(t) });

    expect(tokens).toEqual(["A", "B"]);
  });

  it("executes tool calls and sends results back to AI", async () => {
    // Track AI endpoint fetch calls to simulate the multi-turn loop
    let aiCallCount = 0;

    // First AI call: AI requests a tool call
    const toolCallChunks = [
      {
        id: "c4",
        model: "test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  index: 0,
                  type: "function",
                  function: { name: "calendarRead", arguments: '{"start":"2026-02-07","end":"2026-02-08"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "c4",
        model: "test",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ];

    // Second AI call: AI responds with text based on tool results
    const textChunks = [
      {
        id: "c5",
        model: "test",
        choices: [{ index: 0, delta: { content: "You have a meeting today." }, finish_reason: null }],
      },
      {
        id: "c5",
        model: "test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);

      // AI chat endpoint calls (SSE)
      if (url.includes("ai.cf.morgen.so")) {
        lastRequest = { url, init };
        aiCallCount++;
        const chunks = aiCallCount === 1 ? toolCallChunks : textChunks;
        const stream = createSSEStream([
          ...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`),
          "data: [DONE]\n\n",
        ]);
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      // Morgen API calls from tool execution
      if (url.includes("/calendars/list")) {
        return new Response(
          JSON.stringify({ data: { calendars: [{ id: "cal-1", accountId: "acc-1", name: "Work" }] } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/events/list")) {
        return new Response(
          JSON.stringify({ data: { events: [
            { id: "ev-1", calendarId: "cal-1", title: "Team Standup", start: "2026-02-07T09:00:00Z", duration: "PT30M", timeZone: "America/New_York", showWithoutTime: false },
          ] } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    // Need MORGEN_API_KEY for tool execution
    const origKey = process.env.MORGEN_API_KEY;
    process.env.MORGEN_API_KEY = "test-key";

    try {
      const toolCalls: string[] = [];
      const result = await sendChat("what's on my calendar today?", {
        onToolCall: (name) => toolCalls.push(name),
      });

      // Two AI endpoint calls: initial + after tool execution
      expect(aiCallCount).toBe(2);
      // Tool call was executed
      expect(toolCalls).toEqual(["calendarRead"]);
      // Final response is the text from the second AI call
      expect(result.text).toBe("You have a meeting today.");
      // Second AI request should include tool result messages
      const body = JSON.parse(lastRequest!.init?.body as string);
      expect(body.messages).toHaveLength(4); // system + user + assistant(tool_calls) + tool result
      expect(body.messages[2].role).toBe("assistant");
      expect(body.messages[2].tool_calls).toHaveLength(1);
      expect(body.messages[3].role).toBe("tool");
      expect(body.messages[3].tool_call_id).toBe("call_1");
    } finally {
      if (origKey) process.env.MORGEN_API_KEY = origKey;
      else delete process.env.MORGEN_API_KEY;
    }
  });

  it("throws on non-OK HTTP response", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      lastRequest = { url: String(input), init };
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(sendChat("hello")).rejects.toThrow("Chat API error: 401");
  });
});

// ─── Integration test ───
// Requires a live session token. To run:
//   1. Remove .skip below
//   2. Ensure you have a valid session: bun run src/cli.ts auth
//   3. bun test src/__tests__/chat.test.ts

describe.skip("sendChat integration", () => {
  it("sends a prompt and receives a streamed response from live API", async () => {
    // This test uses the real API — requires a valid session token
    const tokens: string[] = [];
    const result = await sendChat("Say hello in exactly one word", {
      onToken: (t) => tokens.push(t),
    });

    // Verify we got a non-empty response
    expect(result.text.length).toBeGreaterThan(0);
    expect(tokens.length).toBeGreaterThan(0);

    // Verify tokens assembled correctly match the full text
    expect(tokens.join("")).toBe(result.text);
  }, 30000); // 30s timeout for API call
});
