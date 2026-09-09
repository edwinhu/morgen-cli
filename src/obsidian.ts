/**
 * Obsidian-vault task source — read-only, no network, no writes to the vault.
 *
 * Transcribed from Morgen desktop 4.0.6's own main-process implementation
 * (classes `MY`, `hM`, `hc` in app.asar's dist/main.js), so ids emitted here
 * are byte-identical to the ones the desktop app uses. See
 * scratch/obsidian-tasks-investigation.md §2.6.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { createHash } from "crypto";
import type { MorgenTask } from "./types";

export interface ObsidianTaskIdWithTid {
  fp: string;
  tid: string;
  vn: string;
}

export interface ObsidianTaskIdWithHash {
  fp: string;
  t: string;
  vn: string;
}

export type ObsidianTaskIdParts = ObsidianTaskIdWithTid | ObsidianTaskIdWithHash;

export interface DecodedObsidianTaskId {
  /** Vault-relative path with a leading slash, spaces unescaped. */
  fp: string;
  /** The 🆔 value on the task line, when the line carries one. */
  tid?: string;
  /** md5(title).slice(0,6), used when the line has no 🆔. */
  t?: string;
  /** Lowercased vault name. */
  vn: string;
}

export interface ParsedTaskLine {
  /** Title with wikilinks flattened, for display. */
  title: string;
  /** Title as the serializer leaves it — this is what the md5 id hashes. */
  rawTitle: string;
  /** Morgen priority: 1 highest … 9 lowest, 0 = none. */
  priority: number;
  due: string | null;
  scheduled: string | null;
  start: string | null;
  done: string | null;
  cancelled: string | null;
  /** The 🆔 value, or null when the line has none. */
  id: string | null;
  tags: string[];
  completed: boolean;
}

export interface ObsidianVaultTask extends MorgenTask {
  /** The vault name, mirroring the desktop app's task `spaceId`. */
  spaceId: string;
  /** Vault-relative path of the note the line came from. */
  notePath: string;
}

// ---------------------------------------------------------------------------
// Id encoding
// ---------------------------------------------------------------------------

function base64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

/** base64url(JSON.stringify(parts, sortedKeys)), padding stripped. */
export function encodeObsidianTaskId(parts: ObsidianTaskIdParts): string {
  const obj = parts as unknown as Record<string, string>;
  return base64urlEncode(JSON.stringify(obj, Object.keys(obj).sort()));
}

/**
 * Returns null — never throws — for anything that is not a well-formed
 * Obsidian task id. That includes ordinary Morgen ids and Google Tasks ids,
 * which are themselves valid base64 JSON but carry {aid,t,tl}; the key set is
 * what distinguishes them.
 */
export function decodeObsidianTaskId(id: string): DecodedObsidianTaskId | null {
  if (!id) return null;
  let parsed: unknown;
  try {
    const json = Buffer.from(id, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.some((k) => k !== "fp" && k !== "vn" && k !== "tid" && k !== "t")) return null;
  if (typeof obj.fp !== "string" || typeof obj.vn !== "string") return null;

  const hasTid = typeof obj.tid === "string";
  const hasT = typeof obj.t === "string";
  if (hasTid === hasT) return null; // exactly one of the two

  return hasTid
    ? { fp: obj.fp, tid: obj.tid as string, vn: obj.vn }
    : { fp: obj.fp, t: obj.t as string, vn: obj.vn };
}

// ---------------------------------------------------------------------------
// Line parsing — the Obsidian Tasks emoji format
// ---------------------------------------------------------------------------

const INDENTATION = /^([\s\t>]*)/;
const LIST_MARKER = /([-*+]|[0-9]+\.)/;
const CHECKBOX = /\[(.)\]/u;
const AFTER_CHECKBOX = / *(.*)/u;
const TASK_REGEX = new RegExp(
  INDENTATION.source + LIST_MARKER.source + " +" + CHECKBOX.source + AFTER_CHECKBOX.source,
  "u"
);
const BLOCK_LINK = / \^[a-zA-Z0-9-]+$/u;
const HASH_TAGS = /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+/g;
const HASH_TAGS_FROM_END = new RegExp(HASH_TAGS.source + "$");

const ID_CHARS = /[a-zA-Z0-9-_]+/;
const PRIORITY_REGEX = /([🔺⏫🔼🔽⏬])️?/u;
const START_DATE_REGEX = /🛫 *(\d{4}-\d{2}-\d{2})/u;
const CREATED_DATE_REGEX = /➕ *(\d{4}-\d{2}-\d{2})/u;
const SCHEDULED_DATE_REGEX = /[⏳⌛] *(\d{4}-\d{2}-\d{2})/u;
const DUE_DATE_REGEX = /[📅📆🗓] *(\d{4}-\d{2}-\d{2})/u;
const DONE_DATE_REGEX = /✅ *(\d{4}-\d{2}-\d{2})/u;
const CANCELLED_DATE_REGEX = /❌ *(\d{4}-\d{2}-\d{2})/u;
const RECURRENCE_REGEX = /🔁 ?([a-zA-Z0-9, !]+)/iu;
const DEPENDS_ON_REGEX = new RegExp(
  "⛔️? *(" + ID_CHARS.source + "( *, *" + ID_CHARS.source + " *)*)",
  "iu"
);
const ID_REGEX = new RegExp("🆔 *(" + ID_CHARS.source + ")", "iu");

/** Morgen's priority table, keyed by the emoji symbol. */
const PRIORITY_BY_SYMBOL: Record<string, number> = {
  "🔺": 1, // Highest
  "⏫": 2, // High
  "🔼": 5, // Medium
  "🔽": 8, // Low
  "⏬": 9, // Lowest
};

/** Only a match that ends the string counts, per the upstream serializer. */
function matchAtEnd(s: string, re: RegExp): RegExpMatchArray | null {
  const m = s.match(re);
  return m && m.index !== undefined && m.index + m[0].length === s.length ? m : null;
}

export function parseTaskLine(line: string): ParsedTaskLine | null {
  const m = line.match(TASK_REGEX);
  if (m === null) return null;

  const statusChar = m[3] ?? " ";
  let body = (m[4] ?? "").trim();
  if (BLOCK_LINK.test(body)) body = body.replace(BLOCK_LINK, "").trim();

  let priority = 0;
  let due: string | null = null;
  let scheduled: string | null = null;
  let start: string | null = null;
  let done: string | null = null;
  let cancelled: string | null = null;
  let id: string | null = null;
  let trailingTags = "";

  // The serializer peels one trailing field per pass until nothing matches.
  let changed: boolean;
  let guard = 0;
  do {
    changed = false;

    const pri = matchAtEnd(body, PRIORITY_REGEX);
    if (pri) {
      priority = PRIORITY_BY_SYMBOL[pri[1] as string] ?? 0;
      body = body.replace(PRIORITY_REGEX, "").trim();
      changed = true;
    }
    for (const [re, set] of [
      [DONE_DATE_REGEX, (v: string) => (done = v)],
      [CANCELLED_DATE_REGEX, (v: string) => (cancelled = v)],
      [DUE_DATE_REGEX, (v: string) => (due = v)],
      [SCHEDULED_DATE_REGEX, (v: string) => (scheduled = v)],
      [START_DATE_REGEX, (v: string) => (start = v)],
      [CREATED_DATE_REGEX, () => undefined],
    ] as Array<[RegExp, (v: string) => unknown]>) {
      const hit = matchAtEnd(body, re);
      if (hit) {
        set(hit[1] as string);
        body = body.replace(re, "").trim();
        changed = true;
      }
    }

    const rec = matchAtEnd(body, RECURRENCE_REGEX);
    if (rec) {
      body = body.replace(RECURRENCE_REGEX, "").trim();
      changed = true;
    }

    const tag = body.match(HASH_TAGS_FROM_END);
    if (tag) {
      body = body.replace(HASH_TAGS_FROM_END, "").trim();
      const t = tag[0].trim();
      trailingTags = trailingTags.length > 0 ? `${t} ${trailingTags}` : t;
      changed = true;
    }

    const idHit = body.match(ID_REGEX);
    if (idHit) {
      body = body.replace(ID_REGEX, "").trim();
      id = (idHit[1] as string).trim();
      changed = true;
    }

    const dep = matchAtEnd(body, DEPENDS_ON_REGEX);
    if (dep) {
      body = body.replace(DEPENDS_ON_REGEX, "").trim();
      changed = true;
    }

    guard++;
  } while (changed && guard <= 20);

  if (trailingTags.length > 0) body += " " + trailingTags;
  const tags = body.match(HASH_TAGS)?.map((t) => t.trim()) ?? [];
  const rawTitle = body.replace(HASH_TAGS, "").trim();

  return {
    title: rawTitle.replace(/\[\[([^\]]*)\]\]/g, "$1"),
    rawTitle,
    priority,
    due,
    scheduled,
    start,
    done,
    cancelled,
    id,
    tags,
    completed: statusChar === "x" || statusChar === "X",
  };
}

// ---------------------------------------------------------------------------
// Vault reading
// ---------------------------------------------------------------------------

interface MorgenVaultConfig {
  /** Vault-absolute directory prefixes to skip, e.g. "/Archive". */
  ignoreDirectories?: string[];
  /** When true, completing a task appends a ✅ done date. */
  isDoneDateEnabled?: boolean;
}

function readVaultConfig(vaultPath: string): MorgenVaultConfig {
  try {
    const raw = readFileSync(join(vaultPath, ".obsidian", "morgen-config.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function collectMarkdownFiles(dir: string, ignored: Set<string>, out: string[]) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (ignored.has(full)) continue;
    if (entry.isDirectory()) collectMarkdownFiles(full, ignored, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
}

function md5Short(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex").slice(0, 6);
}

/**
 * Every task line in the vault. Completed and cancelled tasks are omitted by
 * default, matching what the desktop app hands to its renderer.
 */
export function readVaultTasks(
  vaultPath: string,
  options: { includeCompleted?: boolean } = {}
): ObsidianVaultTask[] {
  try {
    if (!statSync(vaultPath).isDirectory()) return [];
  } catch {
    return [];
  }

  const vaultName = basename(vaultPath);
  const config = readVaultConfig(vaultPath);
  const ignored = new Set((config.ignoreDirectories ?? []).map((d) => join(vaultPath, d)));

  const files: string[] = [];
  collectMarkdownFiles(vaultPath, ignored, files);

  const tasks: ObsidianVaultTask[] = [];
  for (const file of files) {
    const fp = file.slice(vaultPath.length).replaceAll("\\", "/");
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const parsed = parseTaskLine(line);
      if (!parsed || parsed.title.trim().length === 0) continue;
      if (parsed.completed && !options.includeCompleted) continue;

      const id = encodeObsidianTaskId(
        parsed.id
          ? { fp, tid: parsed.id, vn: vaultName.toLowerCase() }
          : { fp, t: md5Short(parsed.rawTitle), vn: vaultName.toLowerCase() }
      );

      tasks.push({
        "@type": "Task",
        id,
        accountId: "obsidian",
        integrationId: "obsidian",
        taskListId: vaultName,
        spaceId: vaultName,
        notePath: fp,
        title: parsed.title,
        due: parsed.due ? `${parsed.due}T00:00:00` : undefined,
        priority: parsed.priority,
        progress: parsed.completed ? "completed" : "needs-action",
        tags: parsed.tags,
      });
    }
  }
  return tasks;
}

/** The single vault task whose encoded id matches, completed ones included. */
export function findVaultTask(vaultPath: string, id: string): ObsidianVaultTask | undefined {
  return readVaultTasks(vaultPath, { includeCompleted: true }).find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// Local completion / re-opening
//
// Ported from ObsidianVaultReader.closeTask / reopenTask in the desktop app's
// dist/main.js: decode the id, re-read the file, find the line whose
// recomputed id matches, and rewrite the checkbox in place. The done date is
// appended only when the vault config enables it.
// ---------------------------------------------------------------------------

const DONE_DATE_SYMBOL = "✅";
const DONE_DATE_FIELD = / *✅ *\d{4}-\d{2}-\d{2}/u;

function formatDoneDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Rewrites the one line in `fp` whose recomputed id is `id`, using `rewrite`.
 * Returns false when the id does not resolve to a rewritable line; throws only
 * when the id is not an Obsidian task id at all.
 */
function rewriteVaultTaskLine(
  vaultPath: string,
  id: string,
  rewrite: (line: string, parsed: ParsedTaskLine) => string | null
): boolean {
  const decoded = decodeObsidianTaskId(id);
  if (!decoded) {
    throw new Error(`${id} is not an Obsidian task id`);
  }

  const vaultName = basename(vaultPath).toLowerCase();
  const file = join(vaultPath, decoded.fp);
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return false;
  }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // CRLF files leave a trailing \r on every line; keep it out of the edit.
    const raw = lines[i] as string;
    const cr = raw.endsWith("\r");
    const line = cr ? raw.slice(0, -1) : raw;

    const parsed = parseTaskLine(line);
    if (!parsed || parsed.title.trim().length === 0) continue;

    const lineId = encodeObsidianTaskId(
      parsed.id
        ? { fp: decoded.fp, tid: parsed.id, vn: vaultName }
        : { fp: decoded.fp, t: md5Short(parsed.rawTitle), vn: vaultName }
    );
    if (lineId !== id) continue;

    const next = rewrite(line, parsed);
    if (next === null) return false;

    lines[i] = cr ? `${next}\r` : next;
    writeFileSync(file, lines.join("\n"), "utf8");
    return true;
  }
  return false;
}

/** Flips the task's checkbox to `[x]`. False when already closed or not found. */
export function closeVaultTask(
  vaultPath: string,
  id: string,
  opts: { now?: Date } = {}
): boolean {
  const doneDateEnabled = readVaultConfig(vaultPath).isDoneDateEnabled === true;
  const now = opts.now ?? new Date();

  return rewriteVaultTaskLine(vaultPath, id, (line, parsed) => {
    if (parsed.completed) return null;
    let next = line.replace(CHECKBOX, "[x]");
    if (doneDateEnabled) {
      const date = `${DONE_DATE_SYMBOL} ${formatDoneDate(now)}`;
      next = DONE_DATE_FIELD.test(next)
        ? next.replace(DONE_DATE_FIELD, ` ${date}`)
        : `${next} ${date}`;
    }
    return next;
  });
}

/** Flips `[x]`/`[X]` back to `[ ]` and drops any ✅ date. False when already open. */
export function reopenVaultTask(vaultPath: string, id: string): boolean {
  return rewriteVaultTaskLine(vaultPath, id, (line, parsed) => {
    if (!parsed.completed) return null;
    return line.replace(CHECKBOX, "[ ]").replace(DONE_DATE_FIELD, "");
  });
}

/** `--vault`, else MORGEN_OBSIDIAN_VAULT, else undefined. */
export function resolveVaultPath(explicit?: string): string | undefined {
  if (explicit && explicit.trim()) return explicit;
  const env = process.env.MORGEN_OBSIDIAN_VAULT;
  if (env && env.trim()) return env;
  return undefined;
}
