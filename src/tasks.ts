/**
 * Tasks Module
 *
 * CRUD operations for Morgen tasks via the public API.
 */

import { morgenFetch } from "./morgen-api";
import type {
  MorgenTask,
  TaskListResponse,
  TaskCreateResponse,
  CreateTaskInput,
  UpdateTaskInput,
} from "./types";

export interface ListTasksOptions {
  limit?: number;
  updatedAfter?: string;
}

export async function listTasks(
  options?: ListTasksOptions
): Promise<MorgenTask[]> {
  const params: Record<string, string> = {};
  if (options?.limit) params.limit = String(options.limit);
  if (options?.updatedAfter) params.updatedAfter = options.updatedAfter;

  const response = await morgenFetch<TaskListResponse>("/tasks/list", {
    params,
  });
  return response.data.tasks;
}

export async function getTask(id: string): Promise<MorgenTask> {
  const response = await morgenFetch<{ data: { task: MorgenTask } }>("/tasks", {
    params: { id },
  });
  return response.data.task;
}

export async function createTask(input: CreateTaskInput): Promise<string> {
  const response = await morgenFetch<TaskCreateResponse>("/tasks/create", {
    method: "POST",
    body: input,
  });
  return response.data.id;
}

export async function updateTask(input: UpdateTaskInput): Promise<void> {
  await morgenFetch<void>("/tasks/update", {
    method: "POST",
    body: input,
  });
}

export async function closeTask(
  id: string,
  occurrenceStart?: string
): Promise<void> {
  await morgenFetch<void>("/tasks/close", {
    method: "POST",
    body: { id, ...(occurrenceStart ? { occurrenceStart } : {}) },
  });
}

export async function reopenTask(
  id: string,
  occurrenceStart?: string
): Promise<void> {
  await morgenFetch<void>("/tasks/reopen", {
    method: "POST",
    body: { id, ...(occurrenceStart ? { occurrenceStart } : {}) },
  });
}

export async function deleteTask(id: string): Promise<void> {
  await morgenFetch<void>("/tasks/delete", {
    method: "POST",
    body: { id },
  });
}

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
