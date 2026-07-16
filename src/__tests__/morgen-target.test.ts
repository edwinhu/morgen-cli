import { describe, expect, test } from "bun:test";
import { classifyTarget, pickTarget, noTargetHint, withTimeout } from "../morgen-cdp";

const page = (url: string) => ({ type: "page", url });

describe("classifyTarget", () => {
  test("morgen:// is the Electron desktop app", () => {
    expect(classifyTarget(page("morgen://./app.html"))).toBe("electron");
  });

  test("a bare app.html URL still counts as Electron", () => {
    expect(classifyTarget(page("file:///opt/Morgen/resources/app.html"))).toBe("electron");
  });

  test("morgen.so is the web app, on any subdomain", () => {
    // web.morgen.so is what the app actually serves today; app.morgen.so is the
    // older host. The matcher keys on the bare domain, so both must classify.
    expect(classifyTarget(page("https://web.morgen.so/"))).toBe("chrome");
    expect(classifyTarget(page("https://app.morgen.so/calendar"))).toBe("chrome");
  });

  test("non-page targets are never classified", () => {
    // A service/shared worker or iframe on the same origin must not win the
    // pick: it carries no cookies, so a matcher without a type filter can bind
    // to it and silently yield nothing.
    expect(classifyTarget({ type: "service_worker", url: "https://web.morgen.so/sw.js" })).toBeNull();
    expect(classifyTarget({ type: "shared_worker", url: "https://web.morgen.so/worker.js" })).toBeNull();
    expect(classifyTarget({ type: "iframe", url: "https://web.morgen.so/frame" })).toBeNull();
  });

  test("unrelated pages are not classified", () => {
    expect(classifyTarget(page("https://example.com"))).toBeNull();
    expect(classifyTarget({ type: "page" })).toBeNull();
  });
});

describe("pickTarget", () => {
  test("prefers Electron even when the web app is listed first", () => {
    const web = page("https://web.morgen.so/calendar");
    const electron = page("morgen://./app.html");
    const picked = pickTarget([web, electron]);
    expect(picked?.source).toBe("electron");
    expect(picked?.target).toBe(electron);
  });

  test("falls back to the web app when no Electron target exists (the Linux shape)", () => {
    const web = page("https://web.morgen.so/calendar");
    const picked = pickTarget([page("https://example.com"), web]);
    expect(picked?.source).toBe("chrome");
    expect(picked?.target).toBe(web);
  });

  test("skips same-origin non-page targets in favour of the real page", () => {
    const web = page("https://web.morgen.so/calendar");
    const picked = pickTarget([
      { type: "service_worker", url: "https://web.morgen.so/sw.js" },
      web,
    ]);
    expect(picked?.target).toBe(web);
  });

  test("returns null when nothing matches", () => {
    expect(pickTarget([page("https://example.com")])).toBeNull();
    expect(pickTarget([])).toBeNull();
  });
});

describe("withTimeout", () => {
  test("passes through a value that resolves in time", async () => {
    expect(await withTimeout(Promise.resolve("ok"), "thing", 1000)).toBe("ok");
  });

  test("propagates the original rejection, not a timeout", async () => {
    const boom = Promise.reject(new Error("boom"));
    await expect(withTimeout(boom, "thing", 1000)).rejects.toThrow("boom");
  });

  test("rejects when the call never settles — the wedged-renderer case", async () => {
    // A wedged page target never answers; without a bound this hangs forever.
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, "Runtime.evaluate", 20)).rejects.toThrow(/timed out after 20ms/);
  });

  test("names the operation so the error says what stalled", async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, "reading credentials", 20)).rejects.toThrow(
      /reading credentials/
    );
  });
});

describe("noTargetHint", () => {
  test("names both routes on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      const hint = noTargetHint(9253, platform);
      expect(hint).toContain("Desktop app:");
      expect(hint).toContain("Web app:");
      expect(hint).toContain("9253");
    }
  });

  test("linux does not suggest a macOS app bundle", () => {
    const hint = noTargetHint(9253, "linux");
    expect(hint).not.toContain("/Applications/");
    expect(hint).toContain("morgen --remote-debugging-port=9253");
  });

  test("darwin suggests the app bundle", () => {
    expect(noTargetHint(9253, "darwin")).toContain(
      "/Applications/Morgen.app/Contents/MacOS/Morgen"
    );
  });

  test("win32 suggests the exe", () => {
    expect(noTargetHint(9253, "win32")).toContain("Morgen.exe");
  });
});
