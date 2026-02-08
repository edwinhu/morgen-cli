/**
 * Morgen API Types
 *
 * Based on https://docs.morgen.so/
 */

export interface MorgenTask {
  "@type": "Task";
  id: string;
  accountId: string;
  integrationId: string;
  taskListId: string;
  title: string;
  description?: string;
  descriptionContentType?: "text/plain" | "text/html";
  due?: string;               // LocalDateTime: YYYY-MM-DDTHH:mm:ss
  timeZone?: string;          // IANA timezone
  estimatedDuration?: string; // ISO 8601 duration (e.g. "PT30M")
  priority?: number;          // 0 (undefined) to 9 (lowest); 1 = highest
  progress?: "needs-action" | "in-process" | "completed" | "failed" | "cancelled";
  position?: number;
  relatedTo?: Record<string, { relationType: "parent" | "child" }>;
  tags?: string[];
  created?: string;
  updated?: string;
}

export interface MorgenTag {
  id: string;
  name: string;
  color?: string;
  updated?: string;
}

export interface MorgenCalendar {
  "@type": "Calendar";
  id: string;
  accountId: string;
  integrationId: string;
  name: string;
  color?: string;
  sortOrder?: number;
  myRights?: {
    mayRead: boolean;
    mayWrite: boolean;
    mayAdmin: boolean;
    mayRSVP: boolean;
  };
}

export interface MorgenEvent {
  "@type": "Event";
  id: string;
  calendarId: string;
  accountId: string;
  title: string;
  start: string;
  duration: string;           // ISO 8601 duration
  timeZone: string;
  showWithoutTime: boolean;
  description?: string;
  participants?: MorgenParticipant[];
  locations?: MorgenLocation[];
  freeBusyStatus?: string;
  privacy?: string;
  recurrenceRules?: string[];
  taskId?: string;            // Links this event to a task (scheduled task block)
}

export interface MorgenParticipant {
  email: string;
  name?: string;
  rsvp?: string;
}

export interface MorgenLocation {
  name?: string;
  uri?: string;
}

export interface MorgenAccount {
  id: string;
  providerId?: string;
  userId?: string;
  integrationId: string;
}

/** Account from /v3/integrations/accounts/list — richer than MorgenAccount */
export interface IntegrationAccount {
  _id: string;
  integrationId: string;
  integrationGroups?: string[];
  providerUserId?: string;
  providerUserDisplayName?: string;
}

export interface IntegrationAccountsResponse {
  data: {
    accounts: IntegrationAccount[];
  };
}

// API Response wrappers
export interface TaskListResponse {
  data: {
    tasks: MorgenTask[];
    labelDefs?: MorgenTag[];
    spaces?: unknown[];
  };
}

export interface TaskCreateResponse {
  data: { id: string };
}

export interface EventListResponse {
  data: { events: MorgenEvent[] };
}

export interface CalendarListResponse {
  data: MorgenCalendar[];
}

export interface TagListResponse {
  data: MorgenTag[];
}

export interface AccountListResponse {
  data: MorgenAccount[];
}

// Input types for create/update operations
export interface CreateTaskInput {
  title: string;
  description?: string;
  descriptionContentType?: "text/plain" | "text/html";
  due?: string;
  timeZone?: string;
  estimatedDuration?: string;
  taskListId?: string;
  priority?: number;
  tags?: string[];
}

export interface UpdateTaskInput {
  id: string;
  title?: string;
  description?: string;
  descriptionContentType?: "text/plain" | "text/html";
  due?: string;
  timeZone?: string;
  estimatedDuration?: string;
  taskListId?: string;
  priority?: number;
  progress?: "needs-action" | "in-process" | "completed" | "failed" | "cancelled";
  tags?: string[];
}

export interface CreateEventInput {
  accountId: string;
  calendarId: string;
  title: string;
  start: string;
  duration: string;
  timeZone: string;
  showWithoutTime: boolean;
  description?: string;
  taskId?: string;            // Link event to a task (creates a scheduled task block)
}

// Decoded Morgen integration task ID
export interface DecodedMorgenTaskId {
  aid: string; // Morgen account ID
  t: string;   // native task ID
  tl: string;  // native task list ID
}

// Calendar list response (from /v3/calendars/list)
export interface CalendarListApiResponse {
  data: {
    calendars: MorgenCalendar[];
  };
}

// Chat types (for ai.cf.morgen.so/openrouter/chat/completions)
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatMessageToolCall[];
  tool_call_id?: string;
}

export interface ChatMessageToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatCompletionChunkDelta {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    id?: string;
    index: number;
    type?: string;
    function: { name?: string; arguments?: string };
  }>;
}

export interface ChatCompletionChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: ChatCompletionChunkDelta;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatResponse {
  text: string;
  toolCalls?: ChatToolCall[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}
