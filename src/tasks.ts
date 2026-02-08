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

/**
 * Resolve integrationId from a Morgen account ID.
 */
async function resolveIntegrationId(accountId: string): Promise<string | null> {
  const accounts = await getAccounts();
  const account = accounts.find((a) => a._id === accountId);
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
  return (response.data.accounts || []).filter(
    (a) => a.integrationGroups?.includes("tasks")
  );
}

export async function listTasks(
  options?: ListTasksOptions
): Promise<MorgenTask[]> {
  const params: Record<string, string> = {};
  if (options?.limit) params.limit = String(options.limit);
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

  const perAccountPromises = accounts.map((acct) =>
    listTasks({ ...options, accountId: acct._id }).catch(() => [] as MorgenTask[])
  );
  const nativePromise = listTasks(options).catch(() => [] as MorgenTask[]);

  const results = await Promise.all([nativePromise, ...perAccountPromises]);
  const allTasks = results.flat();

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
    await morgenFetch<void>("/tasks/close", {
      method: "POST",
      body: {
        id,
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
    await morgenFetch<void>("/tasks/reopen", {
      method: "POST",
      body: {
        id,
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
