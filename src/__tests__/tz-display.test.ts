/**
 * T1 — the shared display-zone resolver.
 *
 * `resolveDisplayTimeZone` is the single answer to "which zone does a read
 * command print in"; `utcMsToZoned` is the UTC-millisecond entry point the free
 * finder needs, since every other helper here takes a floating local string.
 */
import { describe, it, expect } from "bun:test";
import * as time from "../time";

type Resolver = (explicit?: string) => string;
type Zoner = (ms: number, tz: string) => string;

const resolver = () =>
  (time as unknown as { resolveDisplayTimeZone?: Resolver }).resolveDisplayTimeZone;
const zoner = () => (time as unknown as { utcMsToZoned?: Zoner }).utcMsToZoned;

describe("resolveDisplayTimeZone", () => {
  it("is exported from src/time.ts", () => {
    expect(typeof resolver()).toBe("function");
  });

  it("returns an explicit zone unchanged", () => {
    expect(resolver()!("America/New_York")).toBe("America/New_York");
    expect(resolver()!("Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("falls back to the machine zone when given nothing", () => {
    const resolved = resolver()!();
    expect(resolved).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("treats an empty or whitespace-only zone as absent", () => {
    const machine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolver()!("")).toBe(machine);
    expect(resolver()!("   ")).toBe(machine);
  });
});

describe("utcMsToZoned", () => {
  it("is exported from src/time.ts", () => {
    expect(typeof zoner()).toBe("function");
  });

  it("renders the epoch in New York with its offset", () => {
    expect(zoner()!(0, "America/New_York")).toBe("1969-12-31T19:00:00-05:00");
  });

  it("renders the epoch in UTC with a +00:00 offset", () => {
    expect(zoner()!(0, "UTC")).toBe("1970-01-01T00:00:00+00:00");
  });

  it("honours daylight saving", () => {
    // 2026-07-01T16:00:00Z is 12:00 EDT (-04:00).
    expect(zoner()!(Date.parse("2026-07-01T16:00:00Z"), "America/New_York")).toBe(
      "2026-07-01T12:00:00-04:00",
    );
  });

  it("renders a positive offset east of UTC", () => {
    expect(zoner()!(Date.parse("2026-01-15T10:00:00Z"), "Europe/Berlin")).toBe(
      "2026-01-15T11:00:00+01:00",
    );
  });

  it("round-trips back to the same instant through resolveToUtcMs", () => {
    const ms = Date.parse("2026-09-09T15:30:00Z");
    for (const tz of ["America/New_York", "Europe/Berlin", "Asia/Tokyo", "UTC"]) {
      expect(time.resolveToUtcMs(zoner()!(ms, tz))).toBe(ms);
    }
  });
});
