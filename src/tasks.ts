/**
 * Tasks Module
 *
 * All operations go through the Morgen API (api.morgen.so/v3).
 *
 * With session token auth (from 'morgen auth'):
 *   - List: all accounts, including Google Tasks / MS To Do
 *   - Close/Reopen: works on integration tasks (needs integrationId + accountId)
 *   - Create/Update/Delete: Morgen-native tasks only (integration not supported by API)
 *
 * With API key auth (MORGEN_API_KEY):
 *   - List: works for all accounts
 *   - CRUD: Morgen-native tasks only
 */

import { morgenFetch } from "./morgen-api";
import type {
  MorgenTask,
  TaskListResponse,
  TaskCreateResponse,
  CreateTaskInput,
  UpdateTaskInput,
  IntegrationAccount,
  IntegrationAccountsResponse,
  DecodedMorgenTaskId,
} from "./types";

// ---------------------------------------------------------------------------
// ID helpers — decode Morgen's base64-encoded integration task IDs
// ---------------------------------------------------------------------------

/**
 * Try to decode a Morgen task ID as a base64-encoded integration ID.
 * Returns null if it's a plain Morgen-native ID.
 */
export function decodeIntegrationId(morgenId: string): DecodedMorgenTaskId | null {
  try {
    const json = atob(morgenId);
    const parsed = JSON.parse(json);
    if (parsed.aid && parsed.t && parsed.tl) {
      return parsed as DecodedMorgenTaskId;
    }
  } catch {}
  return null;
}

// Account cache (populated lazily)
let accountsCache: IntegrationAccount[] | null = null;

async function getAccounts(): Promise<IntegrationAccount[]> {
  if (!accountsCache) {
    accountsCache = await listIntegrationAccounts();
  }
  return accountsCache;
}

/** Reset accounts cache (for testing). */
export function resetAccountsCache(): void {
  accountsCache = null;
}

/**
 * Resolve integrationId from a Morgen account ID.
 */
async function resolveIntegrationId(accountId: string): Promise<string | null> {
  const accounts = await getAccounts();
  const account = accounts.find((a) => a.id === accountId);
  return account?.integrationId || null;
}

// ---------------------------------------------------------------------------
// Listing (via Morgen API)
// ---------------------------------------------------------------------------

export interface ListTasksOptions {
  limit?: number;
  updatedAfter?: string;
  accountId?: string;
}

export async function listIntegrationAccounts(): Promise<IntegrationAccount[]> {
  const response = await morgenFetch<IntegrationAccountsResponse>(
    "/integrations/accounts/list"
  );
  // Include accounts whose integrationGroups contains "tasks", OR where
  // integrationGroups is absent (field not returned by API — include by default).
  // Accounts with explicit non-tasks groups (e.g. ["calendars"]) are excluded.
  return (response.data.accounts || []).filter(
    (a) => !a.integrationGroups || a.integrationGroups.includes("tasks")
  );
}

export async function listTasks(
  options?: ListTasksOptions
): Promise<MorgenTask[]> {
  const params: Record<string, string> = {};
  // API defaults to ~4 tasks without explicit limit
  params.limit = String(options?.limit || 200);
  if (options?.updatedAfter) params.updatedAfter = options.updatedAfter;
  if (options?.accountId) params.accountId = options.accountId;

  const response = await morgenFetch<TaskListResponse>("/tasks/list", { params });
  return response.data.tasks;
}

export async function listAllTasks(
  options?: Omit<ListTasksOptions, "accountId">
): Promise<MorgenTask[]> {
  const accounts = await listIntegrationAccounts();
  const limit = options?.limit;

  // Fetch sequentially to avoid Morgen API rate limits (parallel causes partial results)
  const allTasks: MorgenTask[] = [];

  // Native tasks first
  try {
    allTasks.push(...await listTasks(options));
  } catch (e: any) {
    console.error(`Warning: failed to fetch native tasks: ${e.message}`);
  }

  // Then each integration account
  for (const acct of accounts) {
    try {
      allTasks.push(...await listTasks({ ...options, accountId: acct.id }));
    } catch (e: any) {
      const name = acct.providerUserDisplayName || acct.id;
      console.error(`Warning: failed to fetch tasks for ${name}: ${e.message}`);
    }
  }

  const seen = new Set<string>();
  const unique = allTasks.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  unique.sort((a, b) => {
    const aComplete = a.progress === "completed";
    const bComplete = b.progress === "completed";
    if (aComplete !== bComplete) return aComplete ? 1 : -1;
    const aDue = a.due || "";
    const bDue = b.due || "";
    if (aDue && bDue) return aDue.localeCompare(bDue);
    if (aDue) return -1;
    if (bDue) return 1;
    return 0;
  });

  return limit ? unique.slice(0, limit) : unique;
}

/**
 * Stream tasks per account in parallel: calls onBatch as each account's
 * response arrives, without waiting for all accounts to complete.
 * Tasks within a batch are in API order; no cross-account sorting is performed.
 */
export async function streamTasks(
  options: Omit<ListTasksOptions, "accountId"> | undefined,
  onBatch: (tasks: MorgenTask[]) => void
): Promise<void> {
  const accounts = await listIntegrationAccounts();

  // Fetch native tasks + all integration accounts in parallel
  const queries: Promise<void>[] = [];

  queries.push(
    listTasks(options).then((tasks) => {
      if (tasks.length > 0) onBatch(tasks);
    })
  );

  for (const acct of accounts) {
    queries.push(
      listTasks({ ...options, accountId: acct.id })
        .then((tasks) => {
          if (tasks.length > 0) onBatch(tasks);
        })
        .catch((e: Error) => {
          const name = acct.providerUserDisplayName || acct.id;
          process.stderr.write(`Warning: failed to fetch tasks for ${name}: ${e.message}\n`);
        })
    );
  }

  await Promise.all(queries);
}

// ---------------------------------------------------------------------------
// Single-task read
// ---------------------------------------------------------------------------

export async function getTask(id: string): Promise<MorgenTask> {
  const response = await morgenFetch<{ data: { task: MorgenTask } }>("/tasks", {
    params: { id },
  });
  return response.data.task;
}

// ---------------------------------------------------------------------------
// Create — Morgen-native only (integration accounts not supported by API)
// ---------------------------------------------------------------------------

export async function createTask(input: CreateTaskInput): Promise<string> {
  const response = await morgenFetch<TaskCreateResponse>("/tasks/create", {
    method: "POST",
    body: input,
  });
  return response.data.id;
}

// ---------------------------------------------------------------------------
// Update — Morgen-native only
// ---------------------------------------------------------------------------

export async function updateTask(input: UpdateTaskInput): Promise<void> {
  await morgenFetch<void>("/tasks/update", { method: "POST", body: input });
}

// ---------------------------------------------------------------------------
// Close / Reopen — works on both native and integration tasks
// For integration tasks, adds integrationId + accountId to the body.
// ---------------------------------------------------------------------------

export async function closeTask(id: string, occurrenceStart?: string): Promise<void> {
  const decoded = decodeIntegrationId(id);
  if (decoded) {
    const integrationId = await resolveIntegrationId(decoded.aid);
    if (!integrationId) {
      throw new Error(`Cannot resolve integration type for account ${decoded.aid}. Run 'morgen auth' to refresh your session.`);
    }
    // The sync service needs the native provider task ID (decoded.t), not the
    // compound Morgen ID. For MS Todo, taskListId (decoded.tl) is also required
    // because the Graph API path is /todo/lists/{listId}/tasks/{taskId}.
    await morgenFetch<void>("/tasks/close", {
      method: "POST",
      body: {
        id: decoded.t,
        taskListId: decoded.tl,
        integrationId,
        accountId: decoded.aid,
        ...(occurrenceStart ? { occurrenceStart } : {}),
      },
    });
  } else {
    await morgenFetch<void>("/tasks/close", {
      method: "POST",
      body: { id, ...(occurrenceStart ? { occurrenceStart } : {}) },
    });
  }
}

export async function reopenTask(id: string, occurrenceStart?: string): Promise<void> {
  const decoded = decodeIntegrationId(id);
  if (decoded) {
    const integrationId = await resolveIntegrationId(decoded.aid);
    if (!integrationId) {
      throw new Error(`Cannot resolve integration type for account ${decoded.aid}. Run 'morgen auth' to refresh your session.`);
    }
    // Same fix as closeTask: native provider IDs, not the compound Morgen ID.
    await morgenFetch<void>("/tasks/reopen", {
      method: "POST",
      body: {
        id: decoded.t,
        taskListId: decoded.tl,
        integrationId,
        accountId: decoded.aid,
        ...(occurrenceStart ? { occurrenceStart } : {}),
      },
    });
  } else {
    await morgenFetch<void>("/tasks/reopen", {
      method: "POST",
      body: { id, ...(occurrenceStart ? { occurrenceStart } : {}) },
    });
  }
}

// ---------------------------------------------------------------------------
// Delete — Morgen-native only
// ---------------------------------------------------------------------------

export async function deleteTask(id: string): Promise<void> {
  await morgenFetch<void>("/tasks/delete", { method: "POST", body: { id } });
}

// ---------------------------------------------------------------------------
// Move — Morgen-native only
// ---------------------------------------------------------------------------

export async function moveTask(
  id: string,
  previousId?: string | null,
  parentId?: string | null
): Promise<void> {
  await morgenFetch<void>("/tasks/move", {
    method: "POST",
    body: { id, previousId, parentId },
  });
}
