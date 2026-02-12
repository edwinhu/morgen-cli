import { describe, it, expect } from "bun:test";
import { convertToTimezone, formatTimeForDisplay } from "../time";

describe("time module", () => {
  describe("convertToTimezone", () => {
    it("converts UTC time to America/New_York (EST)", () => {
      // Feb 12 is EST (UTC-5)
      const result = convertToTimezone("2026-02-12T10:00:00", "UTC", "America/New_York");
      expect(result).toBe("2026-02-12T05:00:00-05:00");
    });

    it("converts between non-UTC timezones", () => {
      // 09:00 in New York (EST) = 15:00 in Berlin (CET, UTC+1)
      const result = convertToTimezone("2026-02-12T09:00:00", "America/New_York", "Europe/Berlin");
      expect(result).toBe("2026-02-12T15:00:00+01:00");
    });

    it("handles same source and target timezone", () => {
      const result = convertToTimezone("2026-02-12T09:00:00", "America/New_York", "America/New_York");
      expect(result).toBe("2026-02-12T09:00:00-05:00");
    });

    it("handles DST transition (summer time)", () => {
      // July 12 is EDT (UTC-4), not EST (UTC-5)
      const result = convertToTimezone("2026-07-12T10:00:00", "UTC", "America/New_York");
      expect(result).toBe("2026-07-12T06:00:00-04:00");
    });

    it("handles date rollover (UTC time early morning → previous day in west)", () => {
      // 02:00 UTC on Feb 12 = 21:00 on Feb 11 in New York (EST, UTC-5)
      const result = convertToTimezone("2026-02-12T02:00:00", "UTC", "America/New_York");
      expect(result).toBe("2026-02-11T21:00:00-05:00");
    });

    it("handles date rollover forward (late night in west → next day in east)", () => {
      // 23:00 in New York on Feb 11 = 05:00 on Feb 12 in Berlin (CET, UTC+1)
      const result = convertToTimezone("2026-02-11T23:00:00", "America/New_York", "Europe/Berlin");
      expect(result).toBe("2026-02-12T05:00:00+01:00");
    });

    it("handles positive UTC offsets", () => {
      // 10:00 UTC = 19:00 in Tokyo (JST, UTC+9)
      const result = convertToTimezone("2026-02-12T10:00:00", "UTC", "Asia/Tokyo");
      expect(result).toBe("2026-02-12T19:00:00+09:00");
    });

    it("handles half-hour offsets", () => {
      // 10:00 UTC = 15:30 in Kolkata (IST, UTC+5:30)
      const result = convertToTimezone("2026-02-12T10:00:00", "UTC", "Asia/Kolkata");
      expect(result).toBe("2026-02-12T15:30:00+05:30");
    });

    it("returns original string unchanged when targetTz is undefined", () => {
      const result = convertToTimezone("2026-02-12T10:00:00", "UTC", undefined as unknown as string);
      expect(result).toBe("2026-02-12T10:00:00");
    });
  });

  describe("formatTimeForDisplay", () => {
    it("returns HH:mm in target timezone", () => {
      const result = formatTimeForDisplay("2026-02-12T10:00:00", "UTC", "America/New_York");
      expect(result).toBe("05:00");
    });

    it("handles DST (summer)", () => {
      const result = formatTimeForDisplay("2026-07-12T10:00:00", "UTC", "America/New_York");
      expect(result).toBe("06:00");
    });

    it("returns original HH:mm when targetTz is undefined", () => {
      const result = formatTimeForDisplay("2026-02-12T10:30:00", "UTC", undefined as unknown as string);
      expect(result).toBe("10:30");
    });
  });
});
