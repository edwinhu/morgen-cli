import { describe, expect, test, afterEach } from "bun:test";
import { convertToTimezone } from "../time";

const Real = Intl.DateTimeFormat;

/**
 * Swap in a counting wrapper around Intl.DateTimeFormat, run `work`, and report
 * how many formatters it built. The wrapper delegates to the real constructor
 * and keeps `supportedLocalesOf` and the prototype intact so any other Intl
 * consumer behaves normally while it is installed; the original is always
 * restored.
 */
function measure<T>(work: () => T): { count: number; result: T } {
  let count = 0;
  const Counting = function (
    this: unknown,
    ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
  ) {
    count++;
    return new Real(...args);
  } as unknown as typeof Intl.DateTimeFormat;
  Object.defineProperty(Counting, "prototype", { value: Real.prototype });
  Counting.supportedLocalesOf = Real.supportedLocalesOf.bind(Real);

  (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = Counting;
  let result: T;
  try {
    result = work();
  } finally {
    (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = Real;
  }
  return { count, result };
}

const TZ = "America/New_York";
const STAMPS = Array.from({ length: 50 }, (_, i) => {
  const hour = String(8 + (i % 12)).padStart(2, "0");
  const minute = String((i * 7) % 60).padStart(2, "0");
  return `2026-09-09T${hour}:${minute}:00`;
});

afterEach(() => {
  (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = Real;
});

describe("Intl.DateTimeFormat is memoized per timezone", () => {
  test("a single conversion builds at most one formatter per distinct zone", () => {
    const { count } = measure(() =>
      convertToTimezone("2026-09-09T11:30:00", TZ, TZ),
    );
    // Two distinct zones are touched: TZ and the internal "UTC" reference.
    expect(count).toBeLessThanOrEqual(2);
  });

  test("50 conversions build no more formatters than 1", () => {
    const one = measure(() => convertToTimezone(STAMPS[0]!, TZ, TZ));
    const fifty = measure(() => STAMPS.map((s) => convertToTimezone(s, TZ, TZ)));
    expect(fifty.count).toBe(one.count);
  });

  test("cached results are identical to cold-cache results", () => {
    const cold = STAMPS.map((s) => convertToTimezone(s, TZ, TZ));
    const warm = STAMPS.map((s) => convertToTimezone(s, TZ, TZ));
    expect(warm).toEqual(cold);
    expect(convertToTimezone("2026-09-09T11:30:00", TZ, TZ)).toBe(
      "2026-09-09T11:30:00-04:00",
    );
    expect(convertToTimezone("2026-01-15T09:00:00", TZ, "Europe/Berlin")).toBe(
      "2026-01-15T15:00:00+01:00",
    );
  });

  test("the real Intl.DateTimeFormat is restored", () => {
    expect(Intl.DateTimeFormat).toBe(Real);
    expect(typeof Intl.DateTimeFormat.supportedLocalesOf).toBe("function");
  });
});
