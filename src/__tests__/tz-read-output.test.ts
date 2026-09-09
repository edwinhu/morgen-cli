/**
 * T3 — `calendar events` prints in the display zone and says which zone that is.
 *
 * Two events, one whose native zone is the machine's and one whose is not, so a
 * record that must actually be re-rendered is exercised. The stub serves only
 * calendars and events, so the `tasks` read path is not covered here.
 */
import { describe, it, expect } from "bun:test";
import { resolve, dirname, join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { startStubApi } from "./helpers/stub-api";
import { resolveToUtcMs } from "../time";

const CLI = resolve(dirname(import.meta.path), "..", "cli.ts");

const MACHINE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** A native zone guaranteed to differ from the machine's, whatever it is. */
const FOREIGN_TZ = MACHINE_TZ === "Europe/Berlin" ? "Asia/Tokyo" : "Europe/Berlin";

const CALENDARS = [
  {
    "@type": "Calendar",
    id: "cal-0",
    accountId: "acc-0",
    integrationId: "google",
    name: "Calendar",
    myRights: { mayRead: true, mayWrite: true, mayAdmin: false, mayRSVP: true },
  },
];

const LOCAL_START = "2026-09-09T10:00:00";
const FOREIGN_START = "2026-09-09T15:00:00";

const EVENTS = [
  {
    "@type": "Event",
    id: "evt-ny",
    calendarId: "cal-0",
    accountId: "acc-0",
    title: "New York event",
    start: LOCAL_START,
    duration: "PT1H",
    timeZone: "America/New_York",
  },
  {
    "@type": "Event",
    id: "evt-foreign",
    calendarId: "cal-0",
    accountId: "acc-0",
    title: "Foreign event",
    start: FOREIGN_START,
    duration: "PT1H",
    timeZone: FOREIGN_TZ,
  },
];

interface Record_ {
  id: string;
  title: string;
  start: string;
  timeZone?: string;
  originalTimeZone?: string;
}

async function run(args: string[]) {
  const configHome = mkdtempSync(join(tmpdir(), "morgen-cfg-"));
  const stub = startStubApi({ calendars: CALENDARS, events: EVENTS });
  try {
    const proc = Bun.spawn(["bun", "run", CLI, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        MORGEN_API_BASE_URL: stub.url,
        MORGEN_API_KEY: "test-key",
        // The runner's own zone, so "the machine zone" means the same thing on
        // both sides of the spawn.
        TZ: MACHINE_TZ,
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
    rmSync(configHome, { recursive: true, force: true });
  }
}

const BASE_ARGS = ["calendar", "events", "--start", "2026-09-09", "--end", "2026-09-10"];

async function jsonRecords(): Promise<Record_[]> {
  const { stdout, exitCode } = await run([...BASE_ARGS, "--json"]);
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(Array.isArray(parsed)).toBe(true);
  return parsed as Record_[];
}

const byId = (records: Record_[], id: string) => records.find((r) => r.id === id)!;

describe("calendar events read path names its display zone", () => {
  it("--json stays a bare array", async () => {
    const records = await jsonRecords();
    expect(records).toHaveLength(EVENTS.length);
  });

  it("every record carries the machine display zone", async () => {
    for (const r of await jsonRecords()) {
      expect(typeof r.timeZone).toBe("string");
      expect(r.timeZone).toBe(MACHINE_TZ);
    }
  });

  it("every record preserves its native zone as originalTimeZone", async () => {
    const records = await jsonRecords();
    expect(byId(records, "evt-ny").originalTimeZone).toBe("America/New_York");
    const foreign = byId(records, "evt-foreign");
    expect(foreign.originalTimeZone).toBe(FOREIGN_TZ);
    expect(foreign.originalTimeZone).not.toBe(foreign.timeZone);
  });

  it("re-renders the foreign record's start without moving the instant", async () => {
    const foreign = byId(await jsonRecords(), "evt-foreign");
    expect(Date.parse(foreign.start)).toBe(resolveToUtcMs(FOREIGN_START, FOREIGN_TZ));
  });

  it("drops no pre-existing key", async () => {
    const records = await jsonRecords();
    expect(records.map((r) => r.id).sort()).toEqual(["evt-foreign", "evt-ny"]);
    expect(byId(records, "evt-ny").title).toBe("New York event");
    expect(byId(records, "evt-foreign").title).toBe("Foreign event");
  });

  it("--ndjson emits one compact object per line, each naming the zone", async () => {
    const { stdout, exitCode } = await run([...BASE_ARGS, "--ndjson"]);
    expect(exitCode).toBe(0);
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(EVENTS.length);
    for (const line of lines) {
      // Compact means no pretty-printed indentation inside the object.
      expect(line).not.toMatch(/^\s/);
      expect(line).not.toContain("\n");
      const record = JSON.parse(line) as Record_;
      expect(record.id).toBeDefined();
      expect(record.timeZone).toBe(MACHINE_TZ);
    }
  });
});
