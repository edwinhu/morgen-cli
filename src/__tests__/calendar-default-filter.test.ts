/**
 * Default calendar filtering from ~/.config/morgen-cli/config.json.
 *
 * Every case here runs the real CLI against the recording stub with
 * XDG_CONFIG_HOME pointed at a throwaway directory, so the user's real config
 * is never read or written.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve, dirname, join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { startStubApi } from "./helpers/stub-api";

const CLI = resolve(dirname(import.meta.path), "..", "cli.ts");

/** The user's real calendar set, verbatim from `morgen calendar --json`. */
const ACC_A = "6659d6fb";
const ACC_B = "6659d96f";
const CALENDARS = [
  { name: "Calendar", accountId: ACC_A },
  { name: "United States holidays", accountId: ACC_A },
  { name: "Birthdays", accountId: ACC_A },
  { name: "Gmail", accountId: ACC_B },
  { name: "Family", accountId: ACC_B },
  { name: "Natalie", accountId: ACC_B },
  { name: "rjj6@nyu.edu", accountId: ACC_B },
  { name: "Holidays in United States", accountId: ACC_B },
].map((c, i) => ({
  "@type": "Calendar",
  id: `cal-${i}`,
  accountId: c.accountId,
  integrationId: "google",
  name: c.name,
  myRights: { mayRead: true, mayWrite: true, mayAdmin: false, mayRSVP: true },
}));

const calId = (name: string) => CALENDARS.find((c) => c.name === name)!.id;

/** One event per calendar, plus two extra on rjj6@nyu.edu. */
const EVENTS = [
  ...CALENDARS.map((c, i) => ({
    "@type": "Event",
    id: `evt-${i}`,
    calendarId: c.id,
    accountId: c.accountId,
    title: `Event on ${c.name}`,
    start: "2026-09-09T10:00:00",
    duration: "PT1H",
    timeZone: "America/New_York",
  })),
  ...[0, 1].map((n) => ({
    "@type": "Event",
    id: `evt-rjj-extra-${n}`,
    calendarId: calId("rjj6@nyu.edu"),
    accountId: ACC_B,
    title: `Colleague meeting ${n}`,
    start: "2026-09-09T14:00:00",
    duration: "PT1H",
    timeZone: "America/New_York",
  })),
];

let configHome: string;

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "morgen-cfg-"));
});
afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
});

/** Write raw text as the config file; `null` leaves the file absent. */
function writeConfig(raw: string | null) {
  const dir = join(configHome, "morgen-cli");
  mkdirSync(dir, { recursive: true });
  if (raw !== null) writeFileSync(join(dir, "config.json"), raw);
}

async function run(args: string[]) {
  const stub = startStubApi({ calendars: CALENDARS, events: EVENTS });
  try {
    const proc = Bun.spawn(["bun", "run", CLI, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        MORGEN_API_BASE_URL: stub.url,
        MORGEN_API_KEY: "test-key",
        HOME: "/tmp/morgen-cli-test-nonexistent",
        MORGEN_SESSION_FILE: "/tmp/morgen-cli-test-nonexistent/session.json",
        XDG_CONFIG_HOME: configHome,
      },
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  } finally {
    stub.close();
  }
}

const EVENT_ARGS = [
  "calendar",
  "events",
  "--start",
  "2026-09-09",
  "--end",
  "2026-09-10",
  "--json",
];

const titles = (stdout: string) =>
  (JSON.parse(stdout) as { title: string }[]).map((e) => e.title).sort();

describe("default calendar filtering from config", () => {
  it("include-only allowlist hides every other calendar", async () => {
    writeConfig(JSON.stringify({ calendars: { include: ["Calendar", "Gmail"] } }));
    const { stdout, exitCode } = await run(EVENT_ARGS);
    expect(exitCode).toBe(0);
    expect(titles(stdout)).toEqual([
      "Event on Calendar",
      "Event on Gmail",
    ]);
  });

  it("exclude-only denylist hides just the named calendars", async () => {
    writeConfig(
      JSON.stringify({
        calendars: { exclude: ["Family", "Natalie", "rjj6@nyu.edu"] },
      })
    );
    const { stdout, exitCode } = await run(EVENT_ARGS);
    expect(exitCode).toBe(0);
    const t = titles(stdout);
    expect(t).not.toContain("Event on Family");
    expect(t).not.toContain("Event on rjj6@nyu.edu");
    expect(t).toContain("Event on Calendar");
    expect(t).toContain("Event on Birthdays");
  });

  it("include is applied first, then exclude", async () => {
    writeConfig(
      JSON.stringify({
        calendars: { include: ["Calendar", "Gmail", "Family"], exclude: ["Family"] },
      })
    );
    const { stdout, exitCode } = await run(EVENT_ARGS);
    expect(exitCode).toBe(0);
    expect(titles(stdout)).toEqual(["Event on Calendar", "Event on Gmail"]);
  });

  it("--all-calendars bypasses the config entirely", async () => {
    writeConfig(JSON.stringify({ calendars: { include: ["Calendar"] } }));
    const { stdout, stderr, exitCode } = await run([
      ...EVENT_ARGS,
      "--all-calendars",
    ]);
    expect(exitCode).toBe(0);
    expect(titles(stdout)).toHaveLength(EVENTS.length);
    expect(stderr).not.toContain("hidden");
  });

  it("explicit --calendars overrides the config", async () => {
    writeConfig(JSON.stringify({ calendars: { include: ["Calendar"] } }));
    const { stdout, exitCode } = await run([
      ...EVENT_ARGS,
      "--calendars",
      "Natalie",
    ]);
    expect(exitCode).toBe(0);
    expect(titles(stdout)).toEqual(["Event on Natalie"]);
  });

  it("explicit --exclude-calendars overrides the config", async () => {
    writeConfig(JSON.stringify({ calendars: { include: ["Calendar"] } }));
    const { stdout, exitCode } = await run([
      ...EVENT_ARGS,
      "--exclude-calendars",
      "Calendar",
    ]);
    expect(exitCode).toBe(0);
    // Flag semantics stay substring-based, so only names containing
    // "calendar" drop out — here, the calendar literally named "Calendar".
    expect(titles(stdout)).not.toContain("Event on Calendar");
    expect(titles(stdout)).toContain("Event on Family");
  });

  it("absent config means all calendars", async () => {
    writeConfig(null);
    const { stdout, stderr, exitCode } = await run(EVENT_ARGS);
    expect(exitCode).toBe(0);
    expect(titles(stdout)).toHaveLength(EVENTS.length);
    expect(stderr).toBe("");
  });

  it("malformed config warns on stderr and falls back to all calendars", async () => {
    writeConfig("{ this is not json");
    const { stdout, stderr, exitCode } = await run(EVENT_ARGS);
    expect(exitCode).toBe(0);
    expect(stderr.toLowerCase()).toContain("config");
    expect(titles(stdout)).toHaveLength(EVENTS.length);
  });

  it("config with wrong types warns and falls back rather than crashing", async () => {
    writeConfig(JSON.stringify({ calendars: { include: "Calendar" } }));
    const { stdout, stderr, exitCode } = await run(EVENT_ARGS);
    expect(exitCode).toBe(0);
    expect(stderr.toLowerCase()).toContain("config");
    expect(titles(stdout)).toHaveLength(EVENTS.length);
  });

  it("config entries match full names exactly, not by substring", async () => {
    writeConfig(JSON.stringify({ calendars: { include: ["calendar"] } }));
    const { stdout, exitCode } = await run(EVENT_ARGS);
    expect(exitCode).toBe(0);
    // Case-insensitive full-name equality: "calendar" matches "Calendar" only,
    // never "United States holidays" and never by substring.
    expect(titles(stdout)).toEqual(["Event on Calendar"]);
  });

  it("the hidden-events notice names the calendars and counts the events", async () => {
    writeConfig(JSON.stringify({ calendars: { include: ["Calendar", "Gmail"] } }));
    const { stderr } = await run(EVENT_ARGS);
    // 8 events hidden: one on each of 6 hidden calendars, plus 2 extra on rjj6.
    expect(stderr).toContain("8 events hidden");
    expect(stderr).toContain("6");
    expect(stderr).toContain("rjj6@nyu.edu");
    expect(stderr).toContain("--all-calendars");
  });

  it("calendar events --json is still a bare array", async () => {
    writeConfig(JSON.stringify({ calendars: { include: ["Calendar", "Gmail"] } }));
    const { stdout } = await run(EVENT_ARGS);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("--filter-meta emits the structured notice on stderr, leaving stdout intact", async () => {
    writeConfig(JSON.stringify({ calendars: { include: ["Calendar", "Gmail"] } }));
    const { stdout, stderr } = await run([...EVENT_ARGS, "--filter-meta"]);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
    const metaLine = stderr
      .split("\n")
      .find((l) => l.trim().startsWith("{"));
    expect(metaLine).toBeDefined();
    const meta = JSON.parse(metaLine!);
    expect(meta.hiddenEventCount).toBe(8);
    expect(meta.hiddenCalendars).toContain("rjj6@nyu.edu");
    expect(meta.hiddenCalendars).toHaveLength(6);
  });

  it("calendar list applies the config and says what it hid", async () => {
    writeConfig(JSON.stringify({ calendars: { include: ["Calendar", "Gmail"] } }));
    const { stdout, stderr, exitCode } = await run(["calendar", "--json"]);
    expect(exitCode).toBe(0);
    const names = (JSON.parse(stdout) as { name: string }[]).map((c) => c.name);
    expect(names.sort()).toEqual(["Calendar", "Gmail"]);
    expect(stderr).toContain("hidden");
    expect(stderr).toContain("--all-calendars");
  });

  it("calendar free asks only for the visible calendars and says so", async () => {
    writeConfig(JSON.stringify({ calendars: { include: ["Calendar", "Gmail"] } }));
    const { stderr, exitCode } = await run([
      "calendar",
      "free",
      "--start",
      "2026-09-09T08:00:00",
      "--end",
      "2026-09-09T18:00:00",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("hidden");
    expect(stderr).toContain("--all-calendars");
  });

  it("calendar events --ndjson keeps emitting bare event records", async () => {
    writeConfig(JSON.stringify({ calendars: { include: ["Calendar", "Gmail"] } }));
    const { stdout, stderr } = await run([
      "calendar",
      "events",
      "--start",
      "2026-09-09",
      "--end",
      "2026-09-10",
      "--ndjson",
    ]);
    const records = stdout
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    expect(records).toHaveLength(2);
    for (const r of records) expect(r["@type"]).toBe("Event");
    expect(stderr).toContain("8 events hidden");
  });
});
