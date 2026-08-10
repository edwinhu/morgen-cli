import { describe, it, expect } from "bun:test";
import { resolve, dirname } from "path";
import { startStubApi } from "./helpers/stub-api";

describe("morgen CLI", () => {
  const CLI = resolve(dirname(import.meta.path), "..", "cli.ts");

  it("shows help with --help", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("Morgen CLI");
    expect(stdout).toContain("COMMANDS");
    expect(stdout).toContain("tasks");
  });

  it("shows version with --version", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "--version"], {
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("shows help with no args", async () => {
    const proc = Bun.spawn(["bun", "run", CLI], {
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("Morgen CLI");
  });

  it("shows error for unknown command", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "nonexistent"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown command");
  });

  it("tasks command fails without any auth", async () => {
    // Bun auto-loads .env, so we need a tmpdir without one
    // Also override HOME to prevent session-based auth
    const tmpdir = (await import("os")).tmpdir();
    const env = {
      ...process.env,
      MORGEN_API_KEY: "",
      HOME: "/tmp/morgen-test-no-auth",
      MORGEN_SESSION_FILE: "/tmp/morgen-test-no-auth/session.json",
    };

    const proc = Bun.spawn(["bun", "run", CLI, "tasks"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
      cwd: tmpdir,
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("authentication");
  });

  it("help shows auth, accounts, and calendar commands", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "--help"], {
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("auth");
    expect(stdout).toContain("accounts");
    expect(stdout).toContain("calendar");
    expect(stdout).toContain("calendar events");
    expect(stdout).toContain("calendar create");
    expect(stdout).toContain("calendar free");
    expect(stdout).toContain("--calendars");
    expect(stdout).toContain("--exclude-calendars");
    expect(stdout).toContain("--only-primary");
    expect(stdout).toContain("MORGEN_API_KEY");
  });

  it("tasks create requires --title", async () => {
    const env = { ...process.env, MORGEN_API_KEY: "test-key" };

    const proc = Bun.spawn(["bun", "run", CLI, "tasks", "create"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--title");
  });

  it("help text includes chat command", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("chat");
  });

  it("chat command without prompt shows error", async () => {
    const env = { ...process.env, MORGEN_API_KEY: "test-key" };

    const proc = Bun.spawn(["bun", "run", CLI, "chat"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("prompt");
  });

  it("help text includes tasks schedule command", async () => {
    const proc = Bun.spawn(["bun", "run", CLI, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("tasks schedule");
  });

  it("tasks schedule requires task id and --start", async () => {
    const env = { ...process.env, MORGEN_API_KEY: "test-key" };

    const proc = Bun.spawn(["bun", "run", CLI, "tasks", "schedule"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("schedule");
  });

  it("calendar create sends recurrenceRules", async () => {
    // Runs the real binary against a recording stub and asserts on the HTTP
    // body the CLI actually sent to POST /events/create.
    const stub = startStubApi();
    try {
      const env = {
        ...process.env,
        MORGEN_API_BASE_URL: stub.url,
        MORGEN_API_KEY: "test-key",
        HOME: "/tmp/morgen-cli-test-nonexistent",
        MORGEN_SESSION_FILE: "/tmp/morgen-cli-test-nonexistent/session.json",
      };

      const run = async (recurrenceFlags: string[]) => {
        const proc = Bun.spawn(
          [
            "bun",
            "run",
            CLI,
            "calendar",
            "create",
            "--title",
            "Securities Regulation",
            "--start",
            "2026-08-24T13:30:00",
            "--end",
            "2026-08-24T15:30:00",
            "--tz",
            "America/New_York",
            ...recurrenceFlags,
            "--json",
          ],
          { stdout: "pipe", stderr: "pipe", env }
        );
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        return { stdout, stderr, exitCode };
      };

      const sugar = await run(["--repeat", "weekly", "--until", "2026-11-30"]);
      expect(sugar.stderr).toBe("");
      expect(sugar.exitCode).toBe(0);

      const created = stub.requestsFor("/events/create");
      expect(created.length).toBe(1);
      const sugarBody = created[0]!.body as Record<string, unknown>;
      expect(sugarBody.title).toBe("Securities Regulation");
      expect(sugarBody.recurrenceRules).toEqual([
        {
          "@type": "RecurrenceRule",
          frequency: "weekly",
          interval: 1,
          until: "2026-11-30T23:59:59",
          byDay: [{ "@type": "NDay", day: "mo" }],
        },
      ]);

      // The same series expressed as an RRULE produces an identical payload.
      const raw = await run([
        "--rrule",
        "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;UNTIL=20261130",
      ]);
      expect(raw.stderr).toBe("");
      expect(raw.exitCode).toBe(0);

      const createdAgain = stub.requestsFor("/events/create");
      expect(createdAgain.length).toBe(2);
      const rruleBody = createdAgain[1]!.body as Record<string, unknown>;
      expect(JSON.stringify(rruleBody.recurrenceRules)).toBe(
        JSON.stringify(sugarBody.recurrenceRules)
      );
    } finally {
      stub.close();
    }
  });

  it("calendar create --except excludes occurrences", async () => {
    // Runs the real binary against the recording stub. The stub's /events/list
    // still reports both excepted occurrences, i.e. the provider dropped
    // recurrenceOverrides — so the verified fallback must delete them.
    const encodeId = (calendarId: string, id: string, accountId: string) =>
      Buffer.from(JSON.stringify([calendarId, id, accountId]), "utf8").toString(
        "base64"
      );
    const master = encodeId("cal-stub", "master-1", "acc-stub");
    const occurrence = (date: string, id: string) => ({
      "@type": "Event",
      id: encodeId("cal-stub", id, "acc-stub"),
      calendarId: "cal-stub",
      accountId: "acc-stub",
      title: "Securities Regulation",
      start: `${date}T13:30:00`,
      duration: "PT2H",
      timeZone: "America/New_York",
      recurrenceId: `${date}T13:30:00`,
      masterEventId: master,
    });

    const stub = startStubApi({
      createdEventId: master,
      events: [
        occurrence("2026-09-07", "occ-0907"),
        occurrence("2026-09-14", "occ-0914"),
        occurrence("2026-10-12", "occ-1012"),
      ],
    });
    try {
      const env = {
        ...process.env,
        MORGEN_API_BASE_URL: stub.url,
        MORGEN_API_KEY: "test-key",
        HOME: "/tmp/morgen-cli-test-nonexistent",
        MORGEN_SESSION_FILE: "/tmp/morgen-cli-test-nonexistent/session.json",
      };

      const proc = Bun.spawn(
        [
          "bun",
          "run",
          CLI,
          "calendar",
          "create",
          "--title",
          "Securities Regulation",
          "--start",
          "2026-08-24T13:30:00",
          "--end",
          "2026-08-24T15:30:00",
          "--tz",
          "America/New_York",
          "--repeat",
          "weekly",
          "--until",
          "2026-11-30",
          "--except",
          "2026-09-07,2026-10-12",
          "--json",
        ],
        { stdout: "pipe", stderr: "pipe", env }
      );
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);

      // (1) recurrenceOverrides must NEVER reach the wire. Morgen whitelists
      //     request properties and rejects it with 400 "property
      //     recurrenceOverrides should not exist" (verified live 2026-08-10),
      //     which would fail the entire create.
      const created = stub.requestsFor("/events/create");
      expect(created).toHaveLength(1);
      const body = created[0]!.body as Record<string, unknown>;
      expect(body).not.toHaveProperty("recurrenceOverrides");
      expect(JSON.stringify(body)).not.toContain("recurrenceOverrides");

      // (2) Exclusion therefore happens by deleting each excepted occurrence —
      //     seriesUpdateMode on the QUERY STRING, body exactly {id, accountId,
      //     calendarId}, and only the excepted occurrences touched.
      const deletes = stub.requestsFor("/events/delete");
      expect(deletes).toHaveLength(2);
      const deletedIds = deletes.map(
        (d) => (d.body as Record<string, unknown>).id
      );
      expect(deletedIds).toEqual([
        encodeId("cal-stub", "occ-0907", "acc-stub"),
        encodeId("cal-stub", "occ-1012", "acc-stub"),
      ]);
      for (const del of deletes) {
        expect(del.method).toBe("POST");
        expect(del.query.seriesUpdateMode).toBe("single");
        const delBody = del.body as Record<string, unknown>;
        expect(Object.keys(delBody).sort()).toEqual([
          "accountId",
          "calendarId",
          "id",
        ]);
        expect(delBody.accountId).toBe("acc-stub");
        expect(delBody.calendarId).toBe("cal-stub");
        expect(JSON.stringify(del.body)).not.toContain("seriesUpdateMode");
      }

      // (3) stdout names the mechanism that actually took effect.
      const out = JSON.parse(stdout.trim()) as {
        id: string;
        exclusions?: { mechanism?: string; deleted?: string[] };
      };
      expect(out.id).toBe(master);
      expect(out.exclusions?.mechanism).toBe("delete");
    } finally {
      stub.close();
    }
  });

  it("calendar update series mode", async () => {
    // Runs the real binary against the recording stub: seriesUpdateMode must
    // travel on the QUERY STRING (a body-borne one returns HTTP 400), and a
    // value outside single|future|all must be rejected before any request.
    const eventId = Buffer.from(
      JSON.stringify(["cal-stub", "evt-1", "acc-stub"]),
      "utf8"
    ).toString("base64");

    const stub = startStubApi();
    try {
      const env = {
        ...process.env,
        MORGEN_API_BASE_URL: stub.url,
        MORGEN_API_KEY: "test-key",
        HOME: "/tmp/morgen-cli-test-nonexistent",
        MORGEN_SESSION_FILE: "/tmp/morgen-cli-test-nonexistent/session.json",
      };

      const run = async (series: string) => {
        const proc = Bun.spawn(
          [
            "bun",
            "run",
            CLI,
            "calendar",
            "update",
            eventId,
            "--title",
            "Securities Regulation",
            "--series",
            series,
            "--json",
          ],
          { stdout: "pipe", stderr: "pipe", env }
        );
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        return { stdout, stderr, exitCode };
      };

      // (a) --series all reaches the wire as ?seriesUpdateMode=all, never body.
      const ok = await run("all");
      expect(ok.stderr).toBe("");
      expect(ok.exitCode).toBe(0);

      const updates = stub.requestsFor("/events/update");
      expect(updates).toHaveLength(1);
      const update = updates[0]!;
      expect(update.method).toBe("POST");
      expect(update.query.seriesUpdateMode).toBe("all");
      const body = update.body as Record<string, unknown>;
      expect(body.title).toBe("Securities Regulation");
      expect(Object.keys(body)).not.toContain("seriesUpdateMode");
      expect(JSON.stringify(body)).not.toContain("seriesUpdateMode");

      // (b) An invalid mode is a hard error naming the flag and the value, and
      //     no request whatsoever reaches the API.
      //     The value must be distinctive: "al" is a substring of "Invalid" and
      //     of the "use single, future or all" hint, so asserting on it would
      //     pass against a message that never echoes the user's input.
      const requestsBefore = stub.requests.length;
      const bad = await run("weekley");
      expect(bad.exitCode).not.toBe(0);
      expect(bad.stderr).toContain("--series");
      expect(bad.stderr).toMatch(/"weekley"/);
      expect(stub.requests.length).toBe(requestsBefore);

      //     The near-miss truncation is the one a user actually types. It is
      //     asserted quoted, so the assertion can only be satisfied by a
      //     message that echoes the offending value back.
      const truncated = await run("al");
      expect(truncated.exitCode).not.toBe(0);
      expect(truncated.stderr).toContain("--series");
      expect(truncated.stderr).toMatch(/"al"/);
      expect(stub.requests.length).toBe(requestsBefore);
    } finally {
      stub.close();
    }
  });

  it("calendar update sends recurrenceRules", async () => {
    // printHelp advertises `calendar update <id> --repeat weekly:MO,WE --series
    // future`, but nothing pinned the recurrence half of the update body: the
    // rule could vanish and the command would still report success.
    const eventId = Buffer.from(
      JSON.stringify(["cal-stub", "evt-1", "acc-stub"]),
      "utf8"
    ).toString("base64");

    const stub = startStubApi();
    try {
      const env = {
        ...process.env,
        MORGEN_API_BASE_URL: stub.url,
        MORGEN_API_KEY: "test-key",
        HOME: "/tmp/morgen-cli-test-nonexistent",
        MORGEN_SESSION_FILE: "/tmp/morgen-cli-test-nonexistent/session.json",
      };

      const run = async (...extra: string[]) => {
        const proc = Bun.spawn(
          ["bun", "run", CLI, "calendar", "update", eventId, ...extra, "--json"],
          { stdout: "pipe", stderr: "pipe", env }
        );
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        return { stderr, exitCode };
      };

      const ok = await run("--repeat", "weekly:MO,WE", "--series", "future");
      expect(ok.stderr).toBe("");
      expect(ok.exitCode).toBe(0);

      const updates = stub.requestsFor("/events/update");
      expect(updates).toHaveLength(1);
      expect(updates[0]!.query.seriesUpdateMode).toBe("future");
      const body = updates[0]!.body as Record<string, unknown>;
      expect(body.recurrenceRules).toEqual([
        {
          "@type": "RecurrenceRule",
          frequency: "weekly",
          interval: 1,
          byDay: [
            { "@type": "NDay", day: "mo" },
            { "@type": "NDay", day: "we" },
          ],
        },
      ]);

      // Bare `--repeat weekly` on update has no --start to take a weekday from,
      // and must still send a rule — a byDay-less weekly, where the provider
      // keeps the event's existing weekday. Sending no recurrenceRules here
      // would be the silent no-op this change exists to remove.
      const bare = await run("--repeat", "weekly");
      expect(bare.exitCode).toBe(0);
      const bareBody = stub.requestsFor("/events/update")[1]!.body as Record<
        string,
        unknown
      >;
      expect(bareBody.recurrenceRules).toEqual([
        { "@type": "RecurrenceRule", frequency: "weekly", interval: 1 },
      ]);
    } finally {
      stub.close();
    }
  });

  it("calendar delete series mode", async () => {
    // printHelp advertises `calendar delete <id> --series all`, and the delete
    // branch has its own parse/exit wiring — covered by nothing until now, so
    // dropping the argument would have left every test green.
    const eventId = Buffer.from(
      JSON.stringify(["cal-stub", "evt-1", "acc-stub"]),
      "utf8"
    ).toString("base64");

    const stub = startStubApi();
    try {
      const env = {
        ...process.env,
        MORGEN_API_BASE_URL: stub.url,
        MORGEN_API_KEY: "test-key",
        HOME: "/tmp/morgen-cli-test-nonexistent",
        MORGEN_SESSION_FILE: "/tmp/morgen-cli-test-nonexistent/session.json",
      };

      const run = async (...extra: string[]) => {
        const proc = Bun.spawn(
          ["bun", "run", CLI, "calendar", "delete", eventId, ...extra, "--json"],
          { stdout: "pipe", stderr: "pipe", env }
        );
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        return { stdout, stderr, exitCode };
      };

      const ok = await run("--series", "all");
      expect(ok.stderr).toBe("");
      expect(ok.exitCode).toBe(0);

      const deletes = stub.requestsFor("/events/delete");
      expect(deletes).toHaveLength(1);
      const del = deletes[0]!;
      expect(del.query.seriesUpdateMode).toBe("all");
      const body = del.body as Record<string, unknown>;
      // The docs are explicit: any property beyond these three is a 400.
      expect(Object.keys(body).sort()).toEqual([
        "accountId",
        "calendarId",
        "id",
      ]);
      expect(JSON.stringify(body)).not.toContain("seriesUpdateMode");

      // Omitting --series sends no mode at all, preserving the old behaviour.
      const bare = await run();
      expect(bare.exitCode).toBe(0);
      const bareDel = stub.requestsFor("/events/delete")[1]!;
      expect(bareDel.query.seriesUpdateMode).toBeUndefined();

      // An invalid mode is rejected before any request reaches the API.
      const before = stub.requests.length;
      const bad = await run("--series", "weekley");
      expect(bad.exitCode).not.toBe(0);
      expect(bad.stderr).toContain("--series");
      expect(bad.stderr).toMatch(/"weekley"/);
      expect(stub.requests.length).toBe(before);
    } finally {
      stub.close();
    }
  });

  it("calendar create recurrence error branches exit non-zero", async () => {
    // The builders throw on these; what is pinned here is that the CLI turns a
    // throw into a named non-zero exit rather than an unhandled stack trace,
    // and that nothing reaches the API.
    const stub = startStubApi();
    try {
      const env = {
        ...process.env,
        MORGEN_API_BASE_URL: stub.url,
        MORGEN_API_KEY: "test-key",
        HOME: "/tmp/morgen-cli-test-nonexistent",
        MORGEN_SESSION_FILE: "/tmp/morgen-cli-test-nonexistent/session.json",
      };

      const run = async (...extra: string[]) => {
        const proc = Bun.spawn(
          [
            "bun", "run", CLI, "calendar", "create",
            "--title", "X",
            "--start", "2026-08-24T13:30:00",
            "--end", "2026-08-24T15:30:00",
            "--tz", "America/New_York",
            ...extra,
          ],
          { stdout: "pipe", stderr: "pipe", env }
        );
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        return { stderr, exitCode };
      };

      const cases: [string[], RegExp][] = [
        [["--rrule", "FREQ=WEEKLY", "--repeat", "weekly"], /--rrule|--repeat/],
        [["--repeat", "weekly", "--until", "2026-11-30", "--count", "4"], /--until|--count/],
        [["--repeat", "fortnightly"], /fortnightly/],
        [["--repeat", "weekly:XX"], /XX/],
        [["--repeat", "weekly", "--interval", "0"], /interval/i],
        [["--except", "2026-09-07"], /--except/],
        // The series' own start date would resolve to the master row, whose
        // single-occurrence delete can take the whole series with it.
        [["--repeat", "weekly", "--except", "2026-08-24"], /series start/],
      ];

      for (const [args, pattern] of cases) {
        const r = await run(...args);
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toMatch(pattern);
        expect(r.stderr).not.toContain("at <anonymous>");
        // The create path resolves the target calendar before validating, so a
        // GET /calendars/list is expected; what must never happen is an event
        // being written on a rejected invocation.
        expect(stub.requestsFor("/events/create")).toHaveLength(0);
      }
    } finally {
      stub.close();
    }
  });

  it("chat command without session token shows auth error", async () => {
    // Ensure no session file exists by using a non-existent config dir.
    // Override MORGEN_SESSION_FILE in case the parent suite set it.
    const env = {
      ...process.env,
      MORGEN_API_KEY: "test-key",
      HOME: "/tmp/morgen-cli-test-nonexistent",
      MORGEN_SESSION_FILE: "/tmp/morgen-cli-test-nonexistent/session.json",
    };

    const proc = Bun.spawn(["bun", "run", CLI, "chat", "hello"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("auth");
  });

  it("calendar events marks recurring rows", async () => {
    // Runs the real binary against the recording stub. /events/list returns a
    // plain event, a master carrying recurrenceRules, and an expanded
    // occurrence carrying only recurrenceId/masterEventId — the shape a live
    // read of the user's calendar actually returns.
    const encodeId = (calendarId: string, id: string, accountId: string) =>
      Buffer.from(JSON.stringify([calendarId, id, accountId]), "utf8").toString(
        "base64"
      );
    const masterId = encodeId("cal-stub", "master-1", "acc-stub");
    const base = {
      "@type": "Event",
      calendarId: "cal-stub",
      accountId: "acc-stub",
      duration: "PT1H",
      timeZone: "America/New_York",
    };

    const stub = startStubApi({
      events: [
        {
          ...base,
          id: encodeId("cal-stub", "plain-1", "acc-stub"),
          title: "One Off Lunch",
          start: "2026-08-24T12:00:00",
        },
        {
          ...base,
          id: masterId,
          title: "Master Seminar",
          start: "2026-08-24T13:30:00",
          recurrenceRules: [
            {
              "@type": "RecurrenceRule",
              frequency: "weekly",
              interval: 1,
              until: "2026-11-30T23:59:59",
              byDay: [{ "@type": "NDay", day: "mo" }],
            },
          ],
        },
        {
          ...base,
          id: encodeId("cal-stub", "occ-0831", "acc-stub"),
          title: "Expanded Occurrence",
          start: "2026-08-31T13:30:00",
          recurrenceId: "2026-08-31T13:30:00",
          recurrenceIdTimeZone: "America/New_York",
          masterEventId: masterId,
        },
      ],
    });

    try {
      // The CLI switches to ndjson when stdout is a pipe, so the human row
      // formatting only happens on a terminal. Run it under a pty (script(1))
      // to see exactly what a user sees.
      const argv = [
        "bun",
        "run",
        CLI,
        "calendar",
        "events",
        "--start",
        "2026-08-24",
        "--end",
        "2026-09-01",
      ];
      const command = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
      const pty =
        process.platform === "darwin"
          ? ["script", "-q", "/dev/null", "sh", "-c", command]
          : ["script", "-qec", command, "/dev/null"];

      const proc = Bun.spawn(pty, {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          MORGEN_API_BASE_URL: stub.url,
          MORGEN_API_KEY: "test-key",
          HOME: "/tmp/morgen-cli-test-nonexistent",
          MORGEN_SESSION_FILE: "/tmp/morgen-cli-test-nonexistent/session.json",
        },
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);

      // Strip ANSI so assertions read on the visible text.
      const plainText = stdout.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
      const lines = plainText.split("\n").filter((l) => l.trim().length > 0);
      const lineFor = (title: string) => {
        const line = lines.find((l) => l.includes(title));
        expect(line).toBeDefined();
        return line!;
      };

      const RECUR = "\u21ba";
      // The master is marked, and its rule is spelled out.
      expect(lineFor("Master Seminar")).toContain(RECUR);
      expect(lineFor("Master Seminar")).toContain("every Monday until 30 Nov");
      // The expanded occurrence is marked from recurrenceId/masterEventId alone.
      expect(lineFor("Expanded Occurrence")).toContain(RECUR);
      // The plain event is not marked.
      expect(lineFor("One Off Lunch")).not.toContain(RECUR);
    } finally {
      stub.close();
    }
  });

  it("rejects unknown flags", async () => {
    // No network in either half: `help` is handled entirely locally, so the
    // only thing under test is argument parsing.
    const run = async (args: string[]) => {
      const proc = Bun.spawn(["bun", "run", CLI, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      return { stdout, stderr, exitCode };
    };

    // (a) An unrecognised flag is a hard error naming the flag. `--rule` is the
    //     real typo that silently produced a plain one-off event.
    const typo = await run(["help", "--rule", "weekly"]);
    expect(typo.exitCode).not.toBe(0);
    expect(typo.stderr).toContain("--rule");

    // Same for the `--flag=value` spelling and for a bare unknown boolean.
    const eqForm = await run(["help", "--rule=weekly"]);
    expect(eqForm.exitCode).not.toBe(0);
    expect(eqForm.stderr).toContain("--rule");

    const bareForm = await run(["help", "--totally-made-up"]);
    expect(bareForm.exitCode).not.toBe(0);
    expect(bareForm.stderr).toContain("--totally-made-up");

    // (b) Companion: every documented flag and alias still parses. Value flags
    //     are given a value; booleans and short forms are passed alone.
    const valueFlags = [
      "title", "description", "due", "duration", "priority", "list", "progress",
      "limit", "tags", "after", "parent", "account",
      "calendar", "calendar-id", "slots", "conferencing", "conf", "room",
      "start", "end", "timezone", "tz", "location", "attendees",
      "alert", "reminder", "min-minutes",
      "rrule", "repeat", "interval", "until", "count", "except", "series",
      "port", "calendars", "exclude-calendars",
    ];
    const boolFlags = [
      "--json", "--ndjson", "--stream", "--help", "--version", "--all",
      "--all-day", "--only-primary", "--no-availability-check",
      "--no-conferencing", "--no-conf",
    ];
    const shortFlags = ["-h", "-v"];

    const invocations: { label: string; args: string[] }[] = [
      ...valueFlags.flatMap((f) => [
        { label: `--${f} <value>`, args: ["help", `--${f}`, "1"] },
        { label: `--${f}=<value>`, args: ["help", `--${f}=1`] },
      ]),
      ...boolFlags.map((f) => ({ label: f, args: ["help", f] })),
      ...shortFlags.map((f) => ({ label: f, args: ["help", f] })),
    ];

    const results = await Promise.all(
      invocations.map(async (inv) => ({ ...inv, ...(await run(inv.args)) }))
    );
    const rejected = results
      .filter((r) => r.exitCode !== 0 || /unknown flag/i.test(r.stderr))
      .map((r) => `${r.label} -> exit ${r.exitCode}: ${r.stderr.trim()}`);
    expect(rejected).toEqual([]);
  });

  it("recurrence smoke script dry-run", async () => {
    // The live path of scripts/recurrence-smoke.ts is run by a human against a
    // real calendar. Only --dry-run is exercised here: it must print the exact
    // payloads it would send and issue no network request at all. The stub is
    // pointed at by MORGEN_API_BASE_URL purely as a tripwire — it must record
    // nothing — and no auth is configured, so a real call could not succeed.
    const SCRIPT = resolve(
      dirname(import.meta.path),
      "..",
      "..",
      "scripts",
      "recurrence-smoke.ts"
    );
    const stub = startStubApi();
    try {
      const env = {
        ...process.env,
        MORGEN_API_BASE_URL: stub.url,
        MORGEN_API_KEY: "",
        HOME: "/tmp/morgen-cli-test-nonexistent",
        MORGEN_SESSION_FILE: "/tmp/morgen-cli-test-nonexistent/session.json",
      };

      const proc = Bun.spawn(["bun", "run", SCRIPT, "--dry-run"], {
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);

      // No network I/O whatsoever.
      expect(stub.requests).toEqual([]);

      const plan = JSON.parse(stdout) as {
        dryRun: boolean;
        requests: {
          method: string;
          path: string;
          params?: Record<string, string>;
          body?: Record<string, unknown>;
        }[];
      };
      expect(plan.dryRun).toBe(true);

      // (1) The create payload it would send: a weekly series with one
      //     excluded occurrence.
      const create = plan.requests.filter((r) => r.path === "/events/create");
      expect(create.length).toBe(1);
      const body = create[0]!.body as Record<string, unknown>;
      expect(create[0]!.method).toBe("POST");
      expect(String(body.title)).toContain("DELETE ME");
      expect(body.start).toBe("2030-03-04T09:00:00");
      expect(body.recurrenceRules).toEqual([
        {
          "@type": "RecurrenceRule",
          frequency: "weekly",
          interval: 1,
          count: 4,
          byDay: [{ "@type": "NDay", day: "mo" }],
        },
      ]);
      // recurrenceOverrides must never appear: Morgen rejects the property
      // outright (400 whitelistValidation), so sending it fails the create.
      expect(body).not.toHaveProperty("recurrenceOverrides");

      // (2) It reads the window back, then tears the series down with
      //     seriesUpdateMode as a QUERY parameter, never in the body.
      const list = plan.requests.filter((r) => r.path === "/events/list");
      expect(list.length).toBeGreaterThanOrEqual(1);

      const del = plan.requests.filter((r) => r.path === "/events/delete");
      expect(del.length).toBe(1);
      expect(del[0]!.params).toEqual({ seriesUpdateMode: "all" });
      expect(Object.keys(del[0]!.body ?? {}).sort()).toEqual([
        "accountId",
        "calendarId",
        "id",
      ]);
    } finally {
      stub.close();
    }
  });

});
