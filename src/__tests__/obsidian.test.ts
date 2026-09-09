import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  encodeObsidianTaskId,
  decodeObsidianTaskId,
  parseTaskLine,
  readVaultTasks,
  findVaultTask,
  resolveVaultPath,
  closeVaultTask,
  reopenVaultTask,
} from "../obsidian";

// ---------------------------------------------------------------------------
// Fixture vault. Built under os.tmpdir(); the real vault is never touched.
// The vault directory itself must be named "notes" -- the vault name is part
// of the encoded task id.
// ---------------------------------------------------------------------------

const EV9_LINE =
  "- [ ] Pre-return inspection: Kia usually offers one ~60 days out. Book it — it tells you excess-wear exposure before turn-in 📅 2026-09-01 🆔 gThNq3";

/** Verified against the running Morgen desktop app (investigation §2.6). */
const EV9_ID =
  "eyJmcCI6Ii9BcmVhcy9FVjkgTGVhc2UtRW5kIERlY2lzaW9uLm1kIiwidGlkIjoiZ1RoTnEzIiwidm4iOiJub3RlcyJ9";

/** A real Google Tasks id: valid base64url JSON, but keys are {aid,t,tl}. */
const GOOGLE_TASK_ID =
  "eyJhaWQiOiI2NjU5ZDczNDY2MTQ1YmFiMWE5ZTNjNWIiLCJ0IjoiWVVSUU4yWnJiVGcyT1RkRGMwTndNdyIsInRsIjoiTURVM09EZ3hPRGMxTWpJNU5qQTVPRGN5T1RBNk1Eb3cifQ";

let root: string;
let vault: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "morgen-cli-obsidian-test-"));
  vault = join(root, "notes");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  mkdirSync(join(vault, "Areas"), { recursive: true });
  mkdirSync(join(vault, "Archive"), { recursive: true });

  writeFileSync(
    join(vault, ".obsidian", "morgen-config.json"),
    JSON.stringify({
      idPolicy: "add-ids",
      ignoreDirectories: ["/Archive"],
      taskImportPolicy: "all",
    })
  );

  writeFileSync(
    join(vault, "Areas", "EV9 Lease-End Decision.md"),
    ["# EV9", "", "Some prose.", EV9_LINE, ""].join("\n")
  );

  writeFileSync(
    join(vault, "Areas", "Finances.md"),
    [
      "- [ ] Amend 2025 federal return — see [[2025 Tax Return Issues]] 🔺 📅 2026-08-15 🆔 5PsUWS",
      "- [x] Already filed 🆔 doneAA ✅ 2026-04-10",
      "- [ ] Untagged chore #home #errand",
      "not a task line at all",
      "",
    ].join("\n")
  );

  // Must be skipped: ignoreDirectories includes "/Archive".
  writeFileSync(
    join(vault, "Archive", "Old.md"),
    "- [ ] Archived task that must not appear 🆔 arcHiV\n"
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Id encoding
// ---------------------------------------------------------------------------

describe("encodeObsidianTaskId", () => {
  it("reproduces the id the desktop app uses, byte for byte", () => {
    expect(
      encodeObsidianTaskId({
        fp: "/Areas/EV9 Lease-End Decision.md",
        tid: "gThNq3",
        vn: "notes",
      })
    ).toBe(EV9_ID);
  });

  it("sorts keys and strips base64 padding for the md5 variant", () => {
    const id = encodeObsidianTaskId({ fp: "/A.md", t: "abc123", vn: "notes" });
    expect(id).not.toContain("=");
    expect(decodeObsidianTaskId(id)).toEqual({ fp: "/A.md", t: "abc123", vn: "notes" });
  });
});

describe("decodeObsidianTaskId", () => {
  it("round-trips the verified EV9 id", () => {
    expect(decodeObsidianTaskId(EV9_ID)).toEqual({
      fp: "/Areas/EV9 Lease-End Decision.md",
      tid: "gThNq3",
      vn: "notes",
    });
  });

  it("returns null (does not throw) for a real Google Tasks id", () => {
    // This id IS valid base64 JSON, so a naive check misfires. Keys are {aid,t,tl}.
    expect(decodeObsidianTaskId(GOOGLE_TASK_ID)).toBeNull();
  });

  it("returns null for a plain Morgen task id", () => {
    expect(decodeObsidianTaskId("native-task-id-xyz")).toBeNull();
  });

  it("returns null for empty, non-base64 and non-JSON input", () => {
    expect(decodeObsidianTaskId("")).toBeNull();
    expect(decodeObsidianTaskId("!!!not base64!!!")).toBeNull();
    expect(decodeObsidianTaskId(btoa("plain text"))).toBeNull();
  });

  it("returns null for JSON that is not an object of the right shape", () => {
    expect(decodeObsidianTaskId(btoa(JSON.stringify([1, 2, 3])))).toBeNull();
    expect(decodeObsidianTaskId(btoa(JSON.stringify({ fp: "/A.md" })))).toBeNull();
    expect(decodeObsidianTaskId(btoa(JSON.stringify({ fp: 1, tid: "x", vn: "n" })))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

describe("parseTaskLine", () => {
  it("parses the emoji fields off a checkbox line", () => {
    const t = parseTaskLine(EV9_LINE);
    expect(t).not.toBeNull();
    expect(t!.title).toBe(
      "Pre-return inspection: Kia usually offers one ~60 days out. Book it — it tells you excess-wear exposure before turn-in"
    );
    expect(t!.due).toBe("2026-09-01");
    expect(t!.id).toBe("gThNq3");
    expect(t!.completed).toBe(false);
    expect(t!.priority).toBe(0); // None
  });

  it("maps every priority symbol through the Morgen priority table", () => {
    const at = (sym: string) => parseTaskLine(`- [ ] t ${sym}`)!.priority;
    expect(at("🔺")).toBe(1); // Highest
    expect(at("⏫")).toBe(2); // High
    expect(at("🔼")).toBe(5); // Medium
    expect(at("🔽")).toBe(8); // Low
    expect(at("⏬")).toBe(9); // Lowest
    expect(parseTaskLine("- [ ] t")!.priority).toBe(0); // None
  });

  it("flattens wikilinks in the title", () => {
    expect(parseTaskLine("- [ ] See [[2025 Tax Return Issues]] soon")!.title).toBe(
      "See 2025 Tax Return Issues soon"
    );
  });

  it("extracts start, scheduled, done and cancelled dates and tags", () => {
    const t = parseTaskLine(
      "- [x] Ship it #work #urgent 🛫 2026-01-01 ⏳ 2026-01-02 📅 2026-01-03 ✅ 2026-01-04"
    )!;
    expect(t.start).toBe("2026-01-01");
    expect(t.scheduled).toBe("2026-01-02");
    expect(t.due).toBe("2026-01-03");
    expect(t.done).toBe("2026-01-04");
    expect(t.completed).toBe(true);
    expect(t.tags).toEqual(["#work", "#urgent"]);
    expect(t.title).toBe("Ship it");
  });

  it("treats [X] as completed and records a cancelled date", () => {
    expect(parseTaskLine("- [X] Done thing")!.completed).toBe(true);
    expect(parseTaskLine("- [ ] Dropped ❌ 2026-02-02")!.cancelled).toBe("2026-02-02");
  });

  it("returns null for lines that are not task checkboxes", () => {
    expect(parseTaskLine("just a paragraph")).toBeNull();
    expect(parseTaskLine("# A heading")).toBeNull();
    expect(parseTaskLine("- a plain bullet")).toBeNull();
    expect(parseTaskLine("")).toBeNull();
  });

  it("parses indented and numbered task lines", () => {
    expect(parseTaskLine("  - [ ] nested")!.title).toBe("nested");
    expect(parseTaskLine("1. [ ] numbered")!.title).toBe("numbered");
  });
});

// ---------------------------------------------------------------------------
// Vault reading
// ---------------------------------------------------------------------------

describe("readVaultTasks", () => {
  it("returns open tasks from the fixture vault with app-compatible ids", () => {
    const tasks = readVaultTasks(vault);
    const ev9 = tasks.find((t) => t.title.startsWith("Pre-return inspection"));
    expect(ev9).toBeDefined();
    expect(ev9!.id).toBe(EV9_ID);
    expect(ev9!.due).toBe("2026-09-01T00:00:00");
    expect(ev9!.priority).toBe(0);
    expect(ev9!.progress).toBe("needs-action");
    expect(ev9!.spaceId).toBe("notes");
    expect(ev9!.integrationId).toBe("obsidian");
  });

  it("honors ignoreDirectories from .obsidian/morgen-config.json", () => {
    const titles = readVaultTasks(vault).map((t) => t.title);
    expect(titles).not.toContain("Archived task that must not appear");
  });

  it("omits completed tasks by default and includes them on request", () => {
    expect(readVaultTasks(vault).map((t) => t.title)).not.toContain("Already filed");
    expect(
      readVaultTasks(vault, { includeCompleted: true }).map((t) => t.title)
    ).toContain("Already filed");
  });

  it("falls back to the md5-of-title id form for a line with no id", () => {
    const t = readVaultTasks(vault).find((x) => x.title.startsWith("Untagged chore"))!;
    const decoded = decodeObsidianTaskId(t.id)!;
    expect(decoded.tid).toBeUndefined();
    expect(decoded.t).toMatch(/^[0-9a-f]{6}$/);
    expect(decoded.fp).toBe("/Areas/Finances.md");
  });

  it("returns an empty array for a directory that is not a vault", () => {
    expect(readVaultTasks(join(root, "nope"))).toEqual([]);
  });
});

describe("findVaultTask", () => {
  it("finds the task whose encoded id matches", () => {
    const t = findVaultTask(vault, EV9_ID);
    expect(t).toBeDefined();
    expect(t!.title).toBe(
      "Pre-return inspection: Kia usually offers one ~60 days out. Book it — it tells you excess-wear exposure before turn-in"
    );
  });

  it("returns undefined for an id that is not in the vault", () => {
    expect(
      findVaultTask(vault, encodeObsidianTaskId({ fp: "/Nope.md", tid: "zzzzzz", vn: "notes" }))
    ).toBeUndefined();
  });

  it("finds a completed task, which readVaultTasks hides by default", () => {
    expect(findVaultTask(vault, encodeObsidianTaskId({
      fp: "/Areas/Finances.md", tid: "doneAA", vn: "notes",
    }))?.title).toBe("Already filed");
  });
});

// ---------------------------------------------------------------------------
// Vault discovery
// ---------------------------------------------------------------------------

describe("resolveVaultPath", () => {
  const original = process.env.MORGEN_OBSIDIAN_VAULT;
  const restore = () => {
    if (original === undefined) delete process.env.MORGEN_OBSIDIAN_VAULT;
    else process.env.MORGEN_OBSIDIAN_VAULT = original;
  };

  it("prefers the explicit path over the environment", () => {
    process.env.MORGEN_OBSIDIAN_VAULT = "/env/vault";
    try {
      expect(resolveVaultPath("/explicit/vault")).toBe("/explicit/vault");
    } finally {
      restore();
    }
  });

  it("falls back to MORGEN_OBSIDIAN_VAULT", () => {
    process.env.MORGEN_OBSIDIAN_VAULT = "/env/vault";
    try {
      expect(resolveVaultPath()).toBe("/env/vault");
    } finally {
      restore();
    }
  });

  it("returns undefined when neither is set", () => {
    delete process.env.MORGEN_OBSIDIAN_VAULT;
    try {
      expect(resolveVaultPath()).toBeUndefined();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Local completion / re-opening
//
// Each test gets its own throwaway vault under os.tmpdir(), because these
// mutate files. The real vault is never touched.
// ---------------------------------------------------------------------------

const OPEN_LINE = "- [ ] Roundtrip target 📅 2026-09-09 🆔 zzTest1";
const TARGET_ID = encodeObsidianTaskId({
  fp: "/Inbox/Target.md",
  tid: "zzTest1",
  vn: "notes",
});

interface WriteVault {
  root: string;
  vault: string;
  read: (rel: string) => string;
}

const writeVaults: string[] = [];

/** A vault named "notes" with the given files and done-date setting. */
function makeWriteVault(
  files: Record<string, string>,
  config: Record<string, unknown> = {}
): WriteVault {
  const r = mkdtempSync(join(tmpdir(), "morgen-cli-obsidian-write-"));
  writeVaults.push(r);
  const v = join(r, "notes");
  mkdirSync(join(v, ".obsidian"), { recursive: true });
  writeFileSync(join(v, ".obsidian", "morgen-config.json"), JSON.stringify(config));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(v, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return { root: r, vault: v, read: (rel) => readFileSync(join(v, rel), "utf8") };
}

afterAll(() => {
  for (const r of writeVaults) rmSync(r, { recursive: true, force: true });
});

describe("closeVaultTask", () => {
  it("flips [ ] to [x] and leaves the rest of the line byte-identical", () => {
    const w = makeWriteVault({
      "Inbox/Target.md": `# Target\n\n${OPEN_LINE}\n`,
    });
    expect(closeVaultTask(w.vault, TARGET_ID)).toBe(true);
    expect(w.read("Inbox/Target.md")).toBe(
      "# Target\n\n- [x] Roundtrip target 📅 2026-09-09 🆔 zzTest1\n"
    );
  });

  it("appends no done date when isDoneDateEnabled is false", () => {
    const w = makeWriteVault(
      { "Inbox/Target.md": `${OPEN_LINE}\n` },
      { isDoneDateEnabled: false }
    );
    expect(closeVaultTask(w.vault, TARGET_ID, { now: new Date("2026-09-09T12:00:00Z") })).toBe(
      true
    );
    expect(w.read("Inbox/Target.md")).not.toContain("✅");
    expect(w.read("Inbox/Target.md")).toBe("- [x] Roundtrip target 📅 2026-09-09 🆔 zzTest1\n");
  });

  it("appends exactly one done date from the injected clock when enabled", () => {
    const w = makeWriteVault(
      { "Inbox/Target.md": `${OPEN_LINE}\n` },
      { isDoneDateEnabled: true }
    );
    expect(closeVaultTask(w.vault, TARGET_ID, { now: new Date(2026, 2, 4, 9, 0, 0) })).toBe(true);
    const out = w.read("Inbox/Target.md");
    expect(out).toBe("- [x] Roundtrip target 📅 2026-09-09 🆔 zzTest1 ✅ 2026-03-04\n");
    expect(out.match(/✅/g)!.length).toBe(1);
  });

  it("closes only the matching line and leaves other files untouched", () => {
    const w = makeWriteVault({
      "Inbox/Target.md": [
        "- [ ] Other one 🆔 aaa111",
        OPEN_LINE,
        "- [ ] Third 🆔 ccc333",
        "plain prose",
        "",
      ].join("\n"),
      "Inbox/Elsewhere.md": "- [ ] Untouched 🆔 bbb222\n",
    });
    expect(closeVaultTask(w.vault, TARGET_ID)).toBe(true);
    expect(w.read("Inbox/Target.md")).toBe(
      [
        "- [ ] Other one 🆔 aaa111",
        "- [x] Roundtrip target 📅 2026-09-09 🆔 zzTest1",
        "- [ ] Third 🆔 ccc333",
        "plain prose",
        "",
      ].join("\n")
    );
    expect(w.read("Inbox/Elsewhere.md")).toBe("- [ ] Untouched 🆔 bbb222\n");
  });

  it("matches on the recomputed id, not the line number", () => {
    const w = makeWriteVault({
      "Inbox/Target.md": ["prose", "prose", "prose", OPEN_LINE, ""].join("\n"),
    });
    expect(closeVaultTask(w.vault, TARGET_ID)).toBe(true);
    expect(w.read("Inbox/Target.md")).toBe(
      ["prose", "prose", "prose", "- [x] Roundtrip target 📅 2026-09-09 🆔 zzTest1", ""].join("\n")
    );
  });

  it("matches the md5-of-title id form for a line with no 🆔", () => {
    const w = makeWriteVault({ "Inbox/NoId.md": "- [ ] Has no id at all\n" });
    const id = readVaultTasks(w.vault).find((t) => t.title === "Has no id at all")!.id;
    expect(closeVaultTask(w.vault, id)).toBe(true);
    expect(w.read("Inbox/NoId.md")).toBe("- [x] Has no id at all\n");
  });

  it("is a no-op returning false for an already-closed task", () => {
    const w = makeWriteVault({
      "Inbox/Target.md": "- [x] Roundtrip target 📅 2026-09-09 🆔 zzTest1\n",
    });
    expect(closeVaultTask(w.vault, TARGET_ID)).toBe(false);
    expect(w.read("Inbox/Target.md")).toBe(
      "- [x] Roundtrip target 📅 2026-09-09 🆔 zzTest1\n"
    );
  });

  it("returns false when the id decodes but no line matches", () => {
    const w = makeWriteVault({ "Inbox/Target.md": "- [ ] Someone else 🆔 qqq999\n" });
    expect(closeVaultTask(w.vault, TARGET_ID)).toBe(false);
    expect(w.read("Inbox/Target.md")).toBe("- [ ] Someone else 🆔 qqq999\n");
  });

  it("returns false when the file named by the id does not exist", () => {
    const w = makeWriteVault({ "Inbox/Other.md": "- [ ] x 🆔 qqq999\n" });
    expect(closeVaultTask(w.vault, TARGET_ID)).toBe(false);
  });

  it("throws a clear error for an id that is not an Obsidian id", () => {
    const w = makeWriteVault({ "Inbox/Target.md": `${OPEN_LINE}\n` });
    expect(() => closeVaultTask(w.vault, GOOGLE_TASK_ID)).toThrow(/not an Obsidian task id/i);
    expect(() => closeVaultTask(w.vault, "native-task-id-xyz")).toThrow(
      /not an Obsidian task id/i
    );
  });

  it("preserves CRLF line endings and a missing trailing newline", () => {
    const w = makeWriteVault({
      "Inbox/Target.md": `# Target\r\n\r\n${OPEN_LINE}\r\n- [ ] tail 🆔 ttt111`,
    });
    expect(closeVaultTask(w.vault, TARGET_ID)).toBe(true);
    expect(w.read("Inbox/Target.md")).toBe(
      "# Target\r\n\r\n- [x] Roundtrip target 📅 2026-09-09 🆔 zzTest1\r\n- [ ] tail 🆔 ttt111"
    );
  });
});

describe("reopenVaultTask", () => {
  it("inverts a close", () => {
    const w = makeWriteVault({ "Inbox/Target.md": `# T\n\n${OPEN_LINE}\n` });
    expect(closeVaultTask(w.vault, TARGET_ID)).toBe(true);
    expect(reopenVaultTask(w.vault, TARGET_ID)).toBe(true);
    expect(w.read("Inbox/Target.md")).toBe(`# T\n\n${OPEN_LINE}\n`);
  });

  it("strips a trailing done date", () => {
    const w = makeWriteVault({
      "Inbox/Target.md": "- [x] Roundtrip target 📅 2026-09-09 🆔 zzTest1 ✅ 2026-03-04\n",
    });
    expect(reopenVaultTask(w.vault, TARGET_ID)).toBe(true);
    expect(w.read("Inbox/Target.md")).toBe(`${OPEN_LINE}\n`);
  });

  it("accepts [X] as closed", () => {
    const w = makeWriteVault({
      "Inbox/Target.md": "- [X] Roundtrip target 📅 2026-09-09 🆔 zzTest1\n",
    });
    expect(reopenVaultTask(w.vault, TARGET_ID)).toBe(true);
    expect(w.read("Inbox/Target.md")).toBe(`${OPEN_LINE}\n`);
  });

  it("is a no-op returning false for an already-open task", () => {
    const w = makeWriteVault({ "Inbox/Target.md": `${OPEN_LINE}\n` });
    expect(reopenVaultTask(w.vault, TARGET_ID)).toBe(false);
    expect(w.read("Inbox/Target.md")).toBe(`${OPEN_LINE}\n`);
  });

  it("leaves other lines and other files untouched", () => {
    const w = makeWriteVault({
      "Inbox/Target.md": [
        "- [x] Other closed 🆔 aaa111 ✅ 2026-01-01",
        "- [x] Roundtrip target 📅 2026-09-09 🆔 zzTest1",
        "",
      ].join("\n"),
      "Inbox/Elsewhere.md": "- [x] Untouched 🆔 bbb222 ✅ 2026-01-01\n",
    });
    expect(reopenVaultTask(w.vault, TARGET_ID)).toBe(true);
    expect(w.read("Inbox/Target.md")).toBe(
      ["- [x] Other closed 🆔 aaa111 ✅ 2026-01-01", OPEN_LINE, ""].join("\n")
    );
    expect(w.read("Inbox/Elsewhere.md")).toBe("- [x] Untouched 🆔 bbb222 ✅ 2026-01-01\n");
  });

  it("throws a clear error for a foreign id", () => {
    const w = makeWriteVault({ "Inbox/Target.md": `${OPEN_LINE}\n` });
    expect(() => reopenVaultTask(w.vault, GOOGLE_TASK_ID)).toThrow(/not an Obsidian task id/i);
  });
});
