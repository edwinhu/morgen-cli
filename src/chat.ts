/**
 * Morgen Chat Module
 *
 * SSE streaming chat client for Morgen's AI endpoint.
 * Uses session tokens from morgen-cdp for authentication.
 *
 * Endpoint: POST https://ai.cf.morgen.so/openrouter/chat/completions
 * Auth: Bearer <JWT session token>
 * Format: SSE (text/event-stream) with OpenAI-compatible chunks
 */

import { loadSession } from "./morgen-cdp";
import type {
  ChatCompletionChunk,
  ChatResponse,
  ChatToolCall,
} from "./types";

const CHAT_ENDPOINT =
  "https://ai.cf.morgen.so/openrouter/chat/completions";
const MODEL = "anthropic/claude-haiku-4.5";

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
 * Send a chat message to Morgen's AI endpoint and stream the response.
 *
 * @param prompt - The user message to send
 * @param options.onToken - Callback invoked for each content token as it arrives
 * @returns The complete ChatResponse with assembled text, optional tool calls, and usage
 *
 * @throws Error if no active session token is available
 * @throws Error if the API returns a non-OK HTTP status
 */
export async function sendChat(
  prompt: string,
  options?: { onToken?: (text: string) => void }
): Promise<ChatResponse> {
  const session = await loadSession();
  if (!session) {
    throw new Error(
      "No active Morgen session. Run `morgen auth` first to authenticate."
    );
  }

  const response = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: "text" },
      messages: [{ role: "user", content: prompt }],
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

  // Accumulate the full response
  let text = "";
  const toolCallAccumulators = new Map<
    number,
    { name: string; arguments: string }
  >();
  let usage: ChatResponse["usage"] | undefined;

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
          // Append to existing tool call
          if (tc.function.arguments) {
            existing.arguments += tc.function.arguments;
          }
          if (tc.function.name) {
            existing.name = tc.function.name;
          }
        } else {
          // New tool call
          toolCallAccumulators.set(tc.index, {
            name: tc.function.name ?? "",
            arguments: tc.function.arguments ?? "",
          });
        }
      }
    }

    // Capture usage from final chunk
    if (chunk.usage) {
      usage = {
        prompt_tokens: chunk.usage.prompt_tokens,
        completion_tokens: chunk.usage.completion_tokens,
      };
    }
  }

  // Build tool calls array if any were accumulated
  let toolCalls: ChatToolCall[] | undefined;
  if (toolCallAccumulators.size > 0) {
    toolCalls = [];
    // Sort by index to maintain order
    const sorted = [...toolCallAccumulators.entries()].sort(
      ([a], [b]) => a - b
    );
    for (const [, tc] of sorted) {
      toolCalls.push({ name: tc.name, arguments: tc.arguments });
    }
  }

  return { text, toolCalls, usage };
}
