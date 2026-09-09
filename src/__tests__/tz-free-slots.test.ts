/**
 * T2 — every free slot carries an explicit offset and names its zone.
 *
 * The window is given as absolute UTC instants (trailing Z), so the expected
 * boundaries are fixed no matter which zone the slots are rendered in: only the
 * rendering may change, never the instant.
 */
import { describe, it, expect } from "bun:test";
import { resolve, dirname, join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { startStubApi } from "./helpers/stub-api";

const CLI = resolve(dirname(import.meta.path), "..", "cli.ts");

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

/** One busy hour: 14:00 New York on 2026-09-09 is 18:00Z (EDT, -04:00). */
const BUSY = {
  "@type": "Event",
  id: "evt-busy",
  calendarId: "cal-0",
  accountId: "acc-0",
  title: "Busy",
  start: "2026-09-09T14:00:00",
  duration: "PT1H",
  timeZone: "America/New_York",
};

const WINDOW_START = "2026-09-09T12:00:00Z";
const WINDOW_END = "2026-09-09T22:00:00Z";
const BUSY_START = Date.parse("2026-09-09T18:00:00Z");
const BUSY_END = Date.parse("2026-09-09T19:00:00Z");

interface Slot {
  start: string;
  end: string;
  duration: string;
  timeZone?: string;
}

async function run(args: string[]) {
  const configHome = mkdtempSync(join(tmpdir(), "morgen-cfg-"));
  const stub = startStubApi({ calendars: CALENDARS, events: [BUSY] });
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
        TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
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

const FREE_ARGS = [
  "calendar",
  "free",
  "--start",
  WINDOW_START,
  "--end",
  WINDOW_END,
  "--json",
];

async function slots(args: string[]): Promise<Slot[]> {
  const { stdout, exitCode } = await run(args);
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout) as Slot[];
  expect(parsed.length).toBeGreaterThan(0);
  return parsed;
}

describe("calendar free carries an explicit offset", () => {
  it("never emits a bare or Z-suffixed boundary without --timezone", async () => {
    for (const slot of await slots(FREE_ARGS)) {
      expect(slot.start).toMatch(/[+-]\d{2}:\d{2}$/);
      expect(slot.end).toMatch(/[+-]\d{2}:\d{2}$/);
      expect(slot.start.endsWith("Z")).toBe(false);
      expect(slot.end.endsWith("Z")).toBe(false);
    }
  });

  it("names the display zone on every slot", async () => {
    const machine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const slot of await slots(FREE_ARGS)) {
      expect(typeof slot.timeZone).toBe("string");
      expect(slot.timeZone).toBe(machine);
    }
  });

  it("re-renders the same instants the window and the busy event denote", async () => {
    const found = await slots(FREE_ARGS);
    const instants = found.map((s) => [Date.parse(s.start), Date.parse(s.end)]);
    expect(instants).toEqual([
      [Date.parse(WINDOW_START), BUSY_START],
      [BUSY_END, Date.parse(WINDOW_END)],
    ]);
  });

  it("uses the requested zone's offset when --timezone is explicit", async () => {
    const found = await slots([...FREE_ARGS, "--timezone", "America/New_York"]);
    for (const slot of found) {
      // September is EDT (-04:00); accept -05:00 so the assertion survives a
      // window that straddles the DST boundary.
      expect(slot.start).toMatch(/-0[45]:00$/);
      expect(slot.end).toMatch(/-0[45]:00$/);
      expect(slot.timeZone).toBe("America/New_York");
    }
    expect(found.map((s) => [Date.parse(s.start), Date.parse(s.end)])).toEqual([
      [Date.parse(WINDOW_START), BUSY_START],
      [BUSY_END, Date.parse(WINDOW_END)],
    ]);
  });
});
