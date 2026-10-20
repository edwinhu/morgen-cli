/**
 * Task list names: every listed task carries its list's id and human name,
 * the lists themselves can be enumerated, and listing can be filtered by list.
 *
 * Fixtures mirror real v3 payloads observed on 2026-10-20: Google Tasks puts
 * the list id in a `taskList` label and in `com.google.taskListId` (no
 * top-level taskListId), and every /tasks/list response carries a `labelDefs`
 * entry whose `taskList` enum maps list ids to names, even at limit=1. The
 * Microsoft To Do fixture carries no labels at all, so its list id can only
 * come from the compound task id ({aid, t, tl}).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolve, dirname, join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { startStubApi, type StubApi } from "./helpers/stub-api";
import * as tasksMod from "../tasks";
import { readVaultTasks } from "../obsidian";

const G = "6659d73466145bab1a9e3c5b";
const M = "6659eac266145bab1a9e3c64";
const MY = "MDU3ODgxODc1MjI5NjA5ODcyOTA6MDow";
const FAM = "NERsakk5aGFYM2R0SXhrVQ";
const ORPHAN = "T3JwaGFuTGlzdA";
const MS_TASKS = "AQMkAGQ3-tasks";
const MS_UVA = "AAMkAGQ3-uva";

const compoundId = (aid: string, t: string, tl: string) =>
  btoa(JSON.stringify({ aid, t, tl }));

const googleTask = (t: string, title: string, tl: string) => ({
  "@type": "Task",
  id: compoundId(G, t, tl),
  integrationId: "googleTasks",
  spaceId: "default",
  accountId: G,
  title,
  progress: "needs-action",
  "com.google": { taskListId: tl, taskId: t },
  labels: [{ id: "taskList", value: tl }],
});

const msTask = (t: string, title: string, tl: string) => ({
  "@type": "Task",
  id: compoundId(M, t, tl),
  integrationId: "microsoftToDo",
  spaceId: "default",
  accountId: M,
  title,
  progress: "needs-action",
});

const STUB = {
  taskAccounts: [
    { id: "o365-cal", integrationId: "o365", integrationGroups: ["calendars"], providerUserDisplayName: "Edwin Hu" },
    { id: G, integrationId: "googleTasks", integrationGroups: ["tasks"], providerUserDisplayName: "eddyhu@gmail.com" },
    { id: M, integrationId: "microsoftToDo", integrationGroups: ["tasks"], providerUserDisplayName: "Edwin Hu" },
  ],
  taskLists: {
    "": {
      tasks: [
        { "@type": "Task", id: "native-1", integrationId: "morgen", accountId: "morgen", taskListId: "inbox", title: "Native thing", progress: "needs-action" },
      ],
      labelDefs: [],
    },
    [G]: {
      tasks: [
        googleTask("g1", "Look for a psychiatrist", MY),
        googleTask("g2", "Clean EV9", FAM),
        googleTask("g3", "Orphan task", ORPHAN),
      ],
      labelDefs: [
        {
          id: "taskList", label: "Task List", type: "enum", isDefaultGrouping: true,
          values: [
            { value: MY, label: "My Tasks" },
            { value: FAM, label: "Family CC" },
          ],
        },
        { id: "due", label: "Due date", type: "datetime", values: [] },
      ],
    },
    [M]: {
      tasks: [msTask("m1", "Referee report", MS_UVA)],
      labelDefs: [
        {
          id: "taskList", label: "Task List", type: "enum",
          values: [
            { value: MS_TASKS, label: "Tasks", tags: ["defaultList"] },
            { value: MS_UVA, label: "📥 UVA", tags: ["none"] },
          ],
        },
        { id: "importance", type: "enum", values: [{ value: "high", label: "Important" }] },
      ],
    },
  },
};

const EXPECTED_LISTS = [
  { id: MY, name: "My Tasks", accountId: G, integrationId: "googleTasks" },
  { id: FAM, name: "Family CC", accountId: G, integrationId: "googleTasks" },
  { id: MS_TASKS, name: "Tasks", accountId: M, integrationId: "microsoftToDo" },
  { id: MS_UVA, name: "📥 UVA", accountId: M, integrationId: "microsoftToDo" },
];

const pick = (l: any) => ({ id: l.id, name: l.name, accountId: l.accountId, integrationId: l.integrationId });
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

let stub: StubApi;
let vaultDir: string;
const saved = { base: process.env.MORGEN_API_BASE_URL, key: process.env.MORGEN_API_KEY };

beforeAll(() => {
  stub = startStubApi(STUB);
  process.env.MORGEN_API_BASE_URL = stub.url;
  process.env.MORGEN_API_KEY = "test-key";
  const root = mkdtempSync(join(tmpdir(), "morgen-tasklist-"));
  vaultDir = join(root, "Home Vault");
  mkdirSync(vaultDir);
  writeFileSync(join(vaultDir, "Chores.md"), "# Chores\n\n- [ ] Take out trash\n");
});

afterAll(() => {
  stub.close();
  if (saved.base === undefined) delete process.env.MORGEN_API_BASE_URL;
  else process.env.MORGEN_API_BASE_URL = saved.base;
  if (saved.key === undefined) delete process.env.MORGEN_API_KEY;
  else process.env.MORGEN_API_KEY = saved.key;
  rmSync(dirname(vaultDir), { recursive: true, force: true });
});

describe("tasklist names: module", () => {
  it("annotates Google tasks with list id and name from labelDefs", async () => {
    const tasks = await tasksMod.listTasks({ accountId: G });
    const t = Object.fromEntries(tasks.map((x: any) => [x.title, x]));
    expect(t["Clean EV9"].taskListId).toBe(FAM);
    expect(t["Clean EV9"].taskListName).toBe("Family CC");
    expect(t["Look for a psychiatrist"].taskListId).toBe(MY);
    expect(t["Look for a psychiatrist"].taskListName).toBe("My Tasks");
  });

  it("keeps the list id but invents no name when labelDefs lacks the list", async () => {
    const tasks = await tasksMod.listTasks({ accountId: G });
    const orphan: any = tasks.find((x) => x.title === "Orphan task");
    expect(orphan.taskListId).toBe(ORPHAN);
    expect(orphan.taskListName).toBeUndefined();
  });

  it("derives a label-less Microsoft To Do task's list from its compound id", async () => {
    const tasks = await tasksMod.listTasks({ accountId: M });
    const t: any = tasks.find((x) => x.title === "Referee report");
    expect(t.taskListId).toBe(MS_UVA);
    expect(t.taskListName).toBe("📥 UVA");
  });

  it("leaves a native task's taskListId intact with no name", async () => {
    const tasks = await tasksMod.listTasks();
    const t: any = tasks.find((x) => x.title === "Native thing");
    expect(t.taskListId).toBe("inbox");
    expect(t.taskListName).toBeUndefined();
  });

  it("listTaskLists enumerates every task account's lists", async () => {
    const fn = (tasksMod as any).listTaskLists;
    expect(typeof fn).toBe("function");
    const lists = await fn();
    expect(lists.map(pick).sort(byId)).toEqual([...EXPECTED_LISTS].sort(byId));
  });

  it("listTaskLists narrows to one account", async () => {
    const fn = (tasksMod as any).listTaskLists;
    expect(typeof fn).toBe("function");
    const lists = await fn({ accountId: G });
    expect(lists.map(pick).sort(byId)).toEqual(EXPECTED_LISTS.filter((l) => l.accountId === G).sort(byId));
  });

  it("names an Obsidian task's list after its vault", () => {
    const tasks: any[] = readVaultTasks(vaultDir);
    expect(tasks.length).toBe(1);
    expect(tasks[0].taskListName).toBe("Home Vault");
  });
});

describe("tasklist names: cli", () => {
  const CLI = resolve(dirname(import.meta.path), "..", "cli.ts");

  const run = async (args: string[]) => {
    const env = {
      ...process.env,
      MORGEN_API_BASE_URL: stub.url,
      MORGEN_API_KEY: "test-key",
      HOME: "/tmp/morgen-cli-test-nonexistent",
      MORGEN_SESSION_FILE: "/tmp/morgen-cli-test-nonexistent/session.json",
      XDG_CONFIG_HOME: "/tmp/morgen-cli-test-nonexistent/config",
    };
    const proc = Bun.spawn(["bun", "run", CLI, ...args], { stdout: "pipe", stderr: "pipe", env });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  };
  const ndjson = (s: string) => s.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

  it("tasks --all --ndjson carries taskListName", async () => {
    const r = await run(["tasks", "--all", "--ndjson"]);
    expect(r.exitCode).toBe(0);
    const t = Object.fromEntries(ndjson(r.stdout).map((x: any) => [x.title, x]));
    expect(t["Clean EV9"].taskListName).toBe("Family CC");
    expect(t["Referee report"].taskListName).toBe("📥 UVA");
  });

  it("tasks --all --json carries taskListName", async () => {
    const r = await run(["tasks", "--all", "--json"]);
    expect(r.exitCode).toBe(0);
    const t = Object.fromEntries(JSON.parse(r.stdout).map((x: any) => [x.title, x]));
    expect(t["Clean EV9"].taskListId).toBe(FAM);
    expect(t["Clean EV9"].taskListName).toBe("Family CC");
  });

  it("tasks lists --json lists every task list", async () => {
    const r = await run(["tasks", "lists", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).map(pick).sort(byId)).toEqual([...EXPECTED_LISTS].sort(byId));
  });

  it("tasks lists --ndjson --account narrows to that account", async () => {
    const r = await run(["tasks", "lists", "--ndjson", "--account", G]);
    expect(r.exitCode).toBe(0);
    expect(ndjson(r.stdout).map(pick).sort(byId)).toEqual(EXPECTED_LISTS.filter((l) => l.accountId === G).sort(byId));
  });

  it("tasks --all --list matches a list name case-insensitively", async () => {
    const r = await run(["tasks", "--all", "--list", "family cc", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).map((x: any) => x.title)).toEqual(["Clean EV9"]);
  });

  it("tasks --all --ndjson --list matches a list id", async () => {
    const r = await run(["tasks", "--all", "--ndjson", "--list", MS_UVA]);
    expect(r.exitCode).toBe(0);
    expect(ndjson(r.stdout).map((x: any) => x.title)).toEqual(["Referee report"]);
  });

  it("tasks --account --list filters within one account", async () => {
    const r = await run(["tasks", "--account", G, "--list", "My Tasks", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).map((x: any) => x.title)).toEqual(["Look for a psychiatrist"]);
  });

  it("tasks --list filters before --limit truncates", async () => {
    // "Clean EV9" is the account's second task, so truncating to 1 before
    // filtering would drop it.
    const r = await run(["tasks", "--account", G, "--list", "Family CC", "--limit", "1", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).map((x: any) => x.title)).toEqual(["Clean EV9"]);
    const all = await run(["tasks", "--all", "--list", "Family CC", "--limit", "1", "--json"]);
    expect(all.exitCode).toBe(0);
    expect(JSON.parse(all.stdout).map((x: any) => x.title)).toEqual(["Clean EV9"]);
  });

  it("tasks --vault --list filters vault tasks by vault name", async () => {
    const hit = await run(["tasks", "--vault", vaultDir, "--list", "Home Vault", "--json"]);
    expect(hit.exitCode).toBe(0);
    expect(JSON.parse(hit.stdout).map((x: any) => x.title)).toEqual(["Take out trash"]);
    const miss = await run(["tasks", "--vault", vaultDir, "--list", "Elsewhere", "--json"]);
    expect(miss.exitCode).toBe(0);
    expect(JSON.parse(miss.stdout)).toEqual([]);
  });
});
