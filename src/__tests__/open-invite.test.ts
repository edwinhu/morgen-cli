import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { resolve } from "path";
import {
  createOpenInvite,
  listOpenInvites,
  deleteOpenInvite,
  fetchBookingInfo,
  parseSlots,
} from "../open-invite";
import { resetCalendarCache } from "../calendars";

const FIREBASE_FILE = resolve(tmpdir(), `morgen-fb-test-${process.pid}.json`);

const mockCalendars = [
  {
    "@type": "Calendar",
    id: "WORK_CAL_ID_BASE64",
    accountId: "acc-work",
    integrationId: "o365",
    name: "Calendar",
    isDefault: true,
    ownedBy: { name: "Edwin Hu", email: "work@example.edu" },
    myRights: { mayWriteAll: true, mayWriteOwn: true },
  },
  {
    "@type": "Calendar",
    id: "GMAIL_CAL_ID_BASE64",
    accountId: "acc-personal",
    integrationId: "google",
    name: "Gmail",
    ownedBy: { name: "Eddy Hu", email: "personal@example.com" },
    myRights: { mayWriteAll: true, mayWriteOwn: true },
  },
  {
    "@type": "Calendar",
    id: "READONLY_CAL",
    accountId: "acc-personal",
    integrationId: "google",
    name: "Holidays",
    ownedBy: { email: "personal@example.com" },
    myRights: { mayWriteAll: false, mayWriteOwn: false },
  },
];

describe("open-invite module", () => {
  const originalFetch = globalThis.fetch;
  let commitBodies: any[] = [];
  let listDocs: any[] = [];

  beforeEach(async () => {
    process.env.MORGEN_API_KEY = "test-api-key";
    process.env.MORGEN_FIREBASE_FILE = FIREBASE_FILE;
    resetCalendarCache();
    commitBodies = [];
    listDocs = [];
    // Cached Firebase session with a far-future id token => no CDP / securetoken needed.
    await Bun.write(
      FIREBASE_FILE,
      JSON.stringify({
        uid: "test-uid",
        refreshToken: "rt",
        apiKey: "ak",
        idToken: "test-id-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
      })
    );
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.MORGEN_API_KEY;
    delete process.env.MORGEN_FIREBASE_FILE;
    try {
      await Bun.file(FIREBASE_FILE).delete();
    } catch {}
  });

  function installMockFetch(opts?: { bookingSlots?: number | null }) {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/calendars/list")) {
        return new Response(JSON.stringify({ data: { calendars: mockCalendars } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("firestore.googleapis.com") && url.endsWith(":commit")) {
        commitBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ writeResults: [{}], commitTime: "now" }), {
          status: 200,
        });
      }
      if (url.includes("firestore.googleapis.com") && url.includes("/schedulingLinks?")) {
        return new Response(JSON.stringify({ documents: listDocs }), { status: 200 });
      }
      if (url.includes("/scheduler/fetchBookingInfo")) {
        const slots = opts?.bookingSlots;
        if (slots === null || slots === undefined) {
          return new Response("not found", { status: 404 });
        }
        return new Response(
          JSON.stringify({
            href: "x",
            owner: { email: "work@example.edu" },
            slots: Array.from({ length: slots }, (_, i) => `slot${i}`),
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
  }

  // -- parseSlots -----------------------------------------------------------

  it("parses a slots string into start/end windows", () => {
    const slots = parseSlots(
      "2026-06-15T14:00:00Z/2026-06-15T16:00:00Z, 2026-06-16T18:00:00Z/2026-06-16T19:00:00Z"
    );
    expect(slots).toHaveLength(2);
    expect(slots[0]).toEqual({
      start: "2026-06-15T14:00:00Z",
      end: "2026-06-15T16:00:00Z",
    });
  });

  it("rejects a malformed slot", () => {
    expect(() => parseSlots("2026-06-15T14:00:00Z")).toThrow();
  });

  // -- createOpenInvite -----------------------------------------------------

  it("creates a one-time link doc and returns a book.morgen.so link", async () => {
    installMockFetch({ bookingSlots: 6 });
    const inv = await createOpenInvite({
      slots: parseSlots("2026-06-15T14:00:00Z/2026-06-15T16:00:00Z"),
      title: "Intro call",
      duration: 30,
    });

    expect(inv.type).toBe("one-time-link");
    expect(inv.link).toBe(`https://book.morgen.so/${inv.href}`);
    expect(inv.href).toMatch(/^[A-Za-z0-9]{15}-$/);
    expect(inv.hrefShort).toMatch(/^[a-z0-9]{6}$/);
    expect(inv.providerId).toBe(`${inv.id}@morgen.so`);

    // One Firestore commit with the full one-time-link doc.
    expect(commitBodies).toHaveLength(1);
    const fields = commitBodies[0].writes[0].update.fields;
    expect(fields.type.stringValue).toBe("one-time-link");
    expect(fields.visibility.stringValue).toBe("private");
    expect(fields._id.stringValue).toBe(inv.id);
    expect(fields.mtInternalSync.stringValue).toBe("synced");
    expect(fields.event.mapValue.fields.summary.stringValue).toBe("Intro call");
    const bo = fields.bookingOptions.mapValue.fields;
    expect(bo.recurrent.booleanValue).toBe(false);
    expect(bo.durations.arrayValue.values[0].integerValue).toBe("30");
    expect(bo.predefinedSlots.arrayValue.values[0].stringValue).toBe(
      "2026-06-15T14:00:00Z/2026-06-15T16:00:00Z"
    );
    // __stamp is a server-timestamp transform, not a literal field.
    expect(commitBodies[0].writes[0].updateTransforms[0]).toEqual({
      fieldPath: "__stamp",
      setToServerValue: "REQUEST_TIME",
    });
  });

  it("defaults to the writable default calendar and derives target fields", async () => {
    installMockFetch({ bookingSlots: 4 });
    await createOpenInvite({
      slots: parseSlots("2026-06-15T14:00:00Z/2026-06-15T16:00:00Z"),
    });
    const bo = commitBodies[0].writes[0].update.fields.bookingOptions.mapValue.fields;
    expect(bo.targetCalendar.stringValue).toBe("WORK_CAL_ID_BASE64");
    expect(bo.targetAccount.stringValue).toBe("acc-work");
    expect(bo.organizerAccountEmail.stringValue).toBe("work@example.edu");
  });

  it("selects a calendar by partial name match", async () => {
    installMockFetch({ bookingSlots: 4 });
    await createOpenInvite({
      slots: parseSlots("2026-06-15T14:00:00Z/2026-06-15T16:00:00Z"),
      calendar: "gmail",
    });
    const bo = commitBodies[0].writes[0].update.fields.bookingOptions.mapValue.fields;
    expect(bo.targetCalendar.stringValue).toBe("GMAIL_CAL_ID_BASE64");
    expect(bo.organizerAccountEmail.stringValue).toBe("personal@example.com");
  });

  it("normalizes slot times to UTC Z windows", async () => {
    installMockFetch({ bookingSlots: 1 });
    const inv = await createOpenInvite({
      // +00:00 offset and milliseconds should normalize to a trailing Z, no ms.
      slots: [{ start: "2026-06-15T14:00:00.000+00:00", end: "2026-06-15T15:00:00+00:00" }],
    });
    expect(inv.slots[0]).toBe("2026-06-15T14:00:00Z/2026-06-15T15:00:00Z");
  });

  it("requires at least one slot", async () => {
    installMockFetch({ bookingSlots: 0 });
    await expect(createOpenInvite({ slots: [] })).rejects.toThrow(/slot/i);
  });

  // -- listOpenInvites ------------------------------------------------------

  it("lists only non-deleted one-time links", async () => {
    listDocs = [
      {
        name: ".../schedulingLinks/a%40morgen.so",
        fields: {
          type: { stringValue: "one-time-link" },
          mtInternalSync: { stringValue: "synced" },
          href: { stringValue: "AAA111bbb222ccc-" },
          hrefShort: { stringValue: "abc123" },
          providerId: { stringValue: "a@morgen.so" },
          _id: { stringValue: "a" },
          event: { mapValue: { fields: { summary: { stringValue: "Live one" } } } },
          bookingOptions: {
            mapValue: {
              fields: {
                durations: { arrayValue: { values: [{ integerValue: "30" }] } },
                predefinedSlotsTimezone: { stringValue: "America/New_York" },
                predefinedSlots: { arrayValue: { values: [{ stringValue: "w1/w2" }] } },
              },
            },
          },
        },
      },
      {
        name: ".../schedulingLinks/b%40morgen.so",
        fields: {
          type: { stringValue: "one-time-link" },
          mtInternalSync: { stringValue: "deleted" },
        },
      },
      {
        name: ".../schedulingLinks/c%40morgen.so",
        fields: {
          type: { stringValue: "permanent-link" },
          mtInternalSync: { stringValue: "synced" },
          href: { stringValue: "permanentlink123-" },
        },
      },
    ];
    installMockFetch();
    const invites = await listOpenInvites();
    expect(invites).toHaveLength(1);
    expect(invites[0]!.title).toBe("Live one");
    expect(invites[0]!.link).toBe("https://book.morgen.so/AAA111bbb222ccc-");
    expect(invites[0]!.durations).toEqual([30]);
  });

  // -- deleteOpenInvite -----------------------------------------------------

  it("soft-deletes by href and drops the href field", async () => {
    listDocs = [
      {
        name: ".../schedulingLinks/a%40morgen.so",
        fields: {
          type: { stringValue: "one-time-link" },
          mtInternalSync: { stringValue: "synced" },
          href: { stringValue: "TARGET_HREF-" },
          providerId: { stringValue: "a@morgen.so" },
          _id: { stringValue: "a" },
        },
      },
    ];
    installMockFetch();
    const ok = await deleteOpenInvite("TARGET_HREF-");
    expect(ok).toBe(true);
    expect(commitBodies).toHaveLength(1);
    const write = commitBodies[0].writes[0];
    expect(write.update.fields.mtInternalSync.stringValue).toBe("deleted");
    expect(write.update.fields.href).toBeUndefined();
    expect(write.update.fields.providerId.stringValue).toBe("a@morgen.so");
    // Full overwrite => no updateMask (so the existing href is dropped).
    expect(write.updateMask).toBeUndefined();
  });

  it("returns false when no matching invite exists", async () => {
    listDocs = [];
    installMockFetch();
    const ok = await deleteOpenInvite("nonexistent-");
    expect(ok).toBe(false);
    expect(commitBodies).toHaveLength(0);
  });

  // -- fetchBookingInfo -----------------------------------------------------

  it("returns null when the booking link does not resolve (404)", async () => {
    installMockFetch({ bookingSlots: null });
    const info = await fetchBookingInfo("missing-");
    expect(info).toBeNull();
  });

  it("returns booking info when the link resolves", async () => {
    installMockFetch({ bookingSlots: 3 });
    const info = await fetchBookingInfo("present-");
    expect(info.slots).toHaveLength(3);
  });
});
