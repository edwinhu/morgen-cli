/**
 * Morgen Chat Module
 *
 * SSE streaming chat client for Morgen's AI endpoint.
 * Uses session tokens from morgen-cdp for authentication.
 * Supports tool calling for calendar-aware conversations.
 *
 * Endpoint: POST https://ai.cf.morgen.so/openrouter/chat/completions
 * Auth: Bearer <JWT session token>
 * Format: SSE (text/event-stream) with OpenAI-compatible chunks
 */

import { loadSession } from "./morgen-cdp";
import { TOOL_DEFINITIONS, executeTool } from "./tools";
import type {
  ChatMessage,
  ChatMessageToolCall,
  ChatCompletionChunk,
  ChatResponse,
  ChatToolCall,
} from "./types";

const CHAT_ENDPOINT =
  "https://ai.cf.morgen.so/openrouter/chat/completions";
const MODEL = "anthropic/claude-haiku-4.5";
const MAX_TOOL_ROUNDS = 10;

export interface CalendarFilter {
  calendarIds?: string[];
}

/**
 * Build the system prompt with current time context.
 */
function buildSystemPrompt(filter?: CalendarFilter): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const isoLocal = now.toLocaleString("sv-SE", { timeZone: tz }).replace(" ", "T");
  const offset = now.toLocaleString("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .match(/GMT[+-]\d{1,2}(:\d{2})?/)?.[0] ?? "";

  const lines = [
    "You are a helpful calendar and task management assistant.",
    "You have access to tools that can read and modify the user's calendars, events, and tasks.",
    "When the user asks about their schedule, use the calendarRead tool to look up events.",
    "When creating events, always use calendarRead first to check for conflicts and find the right calendarId.",
    "When the user asks about their tasks or to-dos, use the taskList tool.",
    "You can create, update, close (complete), reopen, and delete tasks.",
    "Note: create, update, and delete only work on Morgen-native tasks. Close and reopen work on integration tasks too.",
    "When the user wants to schedule a task on their calendar, first use taskList to find the task, then use eventCreate with the taskId parameter to create a calendar event linked to the task.",
  ];

  if (filter?.calendarIds?.length) {
    lines.push(
      "",
      `IMPORTANT: The user has filtered calendars. When using calendarRead, ALWAYS include this calendarIds parameter: ${JSON.stringify(filter.calendarIds)}`,
      "Only query events from these specific calendars."
    );
  }

  lines.push("", `Current time: ${isoLocal}${offset}`, `User timezone: ${tz}`);

  return lines.join("\n");
}

/**
 * Parse an SSE (Server-Sent Events) stream into typed ChatCompletionChunk objects.
 *
 * Handles:
 * - Multiple data lines in a single buffer
 * - Data split across buffer boundaries
 * - Comment lines (starting with `:`)
 * - Empty lines
 * - The `data: [DONE]` terminator
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<ChatCompletionChunk> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines (SSE events are separated by double newlines)
      const parts = buffer.split("\n\n");
      // The last part may be incomplete -- keep it in the buffer
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        // Process each line in the event block
        for (const line of trimmed.split("\n")) {
          // Skip comment lines
          if (line.startsWith(":")) continue;
          // Skip non-data lines
          if (!line.startsWith("data: ")) continue;

          const data = line.slice(6); // Remove "data: " prefix
          if (data === "[DONE]") return;

          try {
            const chunk: ChatCompletionChunk = JSON.parse(data);
            yield chunk;
          } catch {
            // Skip malformed SSE chunk
            continue;
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      for (const line of buffer.trim().split("\n")) {
        if (line.startsWith(":")) continue;
        if (!line.startsWith("data: ")) continue;

        const data = line.slice(6);
        if (data === "[DONE]") return;

        try {
          const chunk: ChatCompletionChunk = JSON.parse(data);
          yield chunk;
        } catch {
          // Skip malformed SSE chunk
          continue;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Make a single streaming request to the chat endpoint and collect the response.
 */
async function streamChatRequest(
  token: string,
  messages: ChatMessage[],
  options?: { onToken?: (text: string) => void }
): Promise<{
  text: string;
  toolCalls: ChatToolCall[];
  usage?: ChatResponse["usage"];
  finishReason?: string;
}> {
  const response = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: "text" },
      messages,
      tools: TOOL_DEFINITIONS,
      stream: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Chat API error: ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 200)}` : ""}`
    );
  }

  if (!response.body) {
    throw new Error("Chat API returned no response body");
  }

  let text = "";
  const toolCallAccumulators = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  let usage: ChatResponse["usage"] | undefined;
  let finishReason: string | undefined;

  for await (const chunk of parseSSEStream(response.body)) {
    const choice = chunk.choices[0];
    if (!choice) continue;

    const delta = choice.delta;

    // Accumulate text content
    if (delta.content) {
      text += delta.content;
      options?.onToken?.(delta.content);
    }

    // Accumulate tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const existing = toolCallAccumulators.get(tc.index);
        if (existing) {
          if (tc.function.arguments) {
            existing.arguments += tc.function.arguments;
          }
          if (tc.function.name) {
            existing.name = tc.function.name;
          }
          if (tc.id) {
            existing.id = tc.id;
          }
        } else {
          toolCallAccumulators.set(tc.index, {
            id: tc.id ?? `call_${tc.index}`,
            name: tc.function.name ?? "",
            arguments: tc.function.arguments ?? "",
          });
        }
      }
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }

    if (chunk.usage) {
      usage = {
        prompt_tokens: chunk.usage.prompt_tokens,
        completion_tokens: chunk.usage.completion_tokens,
      };
    }
  }

  // Build tool calls array
  const toolCalls: ChatToolCall[] = [];
  if (toolCallAccumulators.size > 0) {
    const sorted = [...toolCallAccumulators.entries()].sort(
      ([a], [b]) => a - b
    );
    for (const [, tc] of sorted) {
      toolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
    }
  }

  return { text, toolCalls, usage, finishReason };
}

/**
 * Send a chat message to Morgen's AI endpoint with tool execution support.
 *
 * When the AI invokes tools (e.g., calendarRead), this function executes them
 * against the Morgen API and sends results back for a final answer.
 *
 * @param prompt - The user message to send
 * @param options.onToken - Callback invoked for each content token as it arrives
 * @param options.onToolCall - Callback invoked when a tool is being executed
 * @returns The complete ChatResponse with assembled text, optional tool calls, and usage
 */
export async function sendChat(
  prompt: string,
  options?: {
    onToken?: (text: string) => void;
    onToolCall?: (name: string, args: string) => void;
    calendarFilter?: CalendarFilter;
  }
): Promise<ChatResponse> {
  const session = await loadSession();
  if (!session) {
    throw new Error(
      "No active Morgen session. Run `morgen auth` first to authenticate."
    );
  }

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(options?.calendarFilter) },
    { role: "user", content: prompt },
  ];

  let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await streamChatRequest(session.token, messages, options);

    // Accumulate usage across rounds
    if (result.usage) {
      totalUsage.prompt_tokens += result.usage.prompt_tokens;
      totalUsage.completion_tokens += result.usage.completion_tokens;
    }

    // No tool calls — return the final text response
    if (result.toolCalls.length === 0) {
      return {
        text: result.text,
        usage: totalUsage.prompt_tokens > 0 ? totalUsage : undefined,
      };
    }

    // AI wants to call tools — add the assistant message with tool calls
    const assistantToolCalls: ChatMessageToolCall[] = result.toolCalls.map(
      (tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })
    );
    messages.push({
      role: "assistant",
      content: result.text || null,
      tool_calls: assistantToolCalls,
    });

    // Execute each tool and add results
    for (const tc of result.toolCalls) {
      options?.onToolCall?.(tc.name, tc.arguments);
      let toolResult: string;
      try {
        toolResult = await executeTool(tc.name, tc.arguments);
      } catch (err) {
        toolResult = JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }
      messages.push({
        role: "tool",
        content: toolResult,
        tool_call_id: tc.id,
      });
    }
  }

  // If we exhausted tool rounds, return what we have
  return {
    text: "I ran out of tool execution rounds. Please try a simpler query.",
    usage: totalUsage.prompt_tokens > 0 ? totalUsage : undefined,
  };
}
