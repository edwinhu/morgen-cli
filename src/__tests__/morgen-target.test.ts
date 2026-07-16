import { describe, expect, test } from "bun:test";
import {
  classifyTarget,
  pickTarget,
  rankTargets,
  noTargetHint,
  withTimeout,
} from "../morgen-cdp";
import { hostMatches } from "../cdp-endpoint";

describe("rankTargets", () => {
  const page = (url: string) => ({ type: "page", url });

  test("returns EVERY viable target, not just the best", () => {
    // The point: one wedged tab must not fail a refresh another tab could serve.
    const ranked = rankTargets([
      page("https://web.morgen.so/a"),
      page("https://example.com"),
      page("https://web.morgen.so/b"),
    ]);
    expect(ranked).toHaveLength(2);
    expect(ranked.every((r) => r.source === "chrome")).toBe(true);
  });

  test("Electron ranks ahead of web, wherever it appears in the list", () => {
    const ranked = rankTargets([
      page("https://web.morgen.so/"),
      page("morgen://./app.html"),
    ]);
    expect(ranked.map((r) => r.source)).toEqual(["electron", "chrome"]);
  });

  test("excludes non-page and unrelated targets", () => {
    const ranked = rankTargets([
      { type: "service_worker", url: "https://web.morgen.so/sw.js" },
      { type: "shared_worker", url: "https://web.morgen.so/w.js" },
      page("https://example.com"),
      page("https://web.morgen.so/"),
    ]);
    expect(ranked).toHaveLength(1);
  });

  test("empty when nothing matches", () => {
    expect(rankTargets([page("https://example.com")])).toEqual([]);
    expect(rankTargets([])).toEqual([]);
  });
});

const page = (url: string) => ({ type: "page", url });

describe("classifyTarget", () => {
  test("morgen:// is the Electron desktop app", () => {
    expect(classifyTarget(page("morgen://./app.html"))).toBe("electron");
  });

  test("a bare app.html URL still counts as Electron when it is Morgen's", () => {
    expect(classifyTarget(page("file:///opt/Morgen/resources/app.html"))).toBe("electron");
  });

  test("query/fragment cannot make another app look like Morgen", () => {
    // /morgen/i must scan origin+path only. Scanning the whole URL let a route
    // or query decide identity — and 1Password's page at #/morgen/settings is
    // exactly the shape that matters.
    expect(
      classifyTarget(page("chrome-extension://abc/app/app.html#/morgen/settings"))
    ).toBeNull();
    expect(classifyTarget(page("https://example.com/app.html?next=morgen"))).toBeNull();
  });

  test("another app's app.html is NOT the Morgen desktop app", () => {
    // Real target seen live: 1Password's extension serves an app.html. A bare
    // "app.html" match classified it as Electron, and since Electron ranks
    // first it was picked ahead of the real web.morgen.so tab — failing the
    // refresh against 1Password's localStorage.
    expect(
      classifyTarget(
        page("chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/app/app.html#/page/settings")
      )
    ).toBeNull();
    expect(classifyTarget(page("https://example.com/app.html"))).toBeNull();
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
      const hint = noTargetHint([9253, 9222], platform);
      expect(hint).toContain("Desktop app:");
      expect(hint).toContain("Web app:");
      expect(hint).toContain("9253");
    }
  });

  test("linux does not suggest a macOS app bundle", () => {
    const hint = noTargetHint([9253, 9222], "linux");
    expect(hint).not.toContain("/Applications/");
    expect(hint).toContain("morgen --remote-debugging-port=9253");
  });

  test("darwin suggests the app bundle", () => {
    expect(noTargetHint([9253, 9222], "darwin")).toContain(
      "/Applications/Morgen.app/Contents/MacOS/Morgen"
    );
  });

  test("win32 suggests the exe", () => {
    expect(noTargetHint([9253, 9222], "win32")).toContain("Morgen.exe");
  });
});

describe("hostMatches — endpoint identity must not be forgeable", () => {
  test("accepts the domain and its subdomains", () => {
    expect(hostMatches("https://morgen.so/", "morgen.so")).toBe(true);
    expect(hostMatches("https://web.morgen.so/calendar", "morgen.so")).toBe(true);
  });

  test("rejects suffix-confusion hosts", () => {
    // The bug this guards: includes("morgen.so") matched all of these, and the
    // winning target gets credential-reading JS executed in it.
    expect(hostMatches("https://morgen.so.evil.example/", "morgen.so")).toBe(false);
    expect(hostMatches("https://notmorgen.so/", "morgen.so")).toBe(false);
  });

  test("rejects query/fragment mentions", () => {
    expect(hostMatches("https://evil.example/?next=morgen.so", "morgen.so")).toBe(false);
    expect(hostMatches("https://evil.example/#morgen.so", "morgen.so")).toBe(false);
  });

  test("rejects non-http(s) schemes and unparseable input", () => {
    expect(hostMatches("file:///morgen.so/app.html", "morgen.so")).toBe(false);
    expect(hostMatches("not a url", "morgen.so")).toBe(false);
  });

  test("an http(s) page can never be the Electron desktop app", () => {
    // Electron ranks FIRST, so a false positive here beats the genuine tab and
    // gets credential-reading JS run in the impostor. An earlier cut matched
    // /morgen/i across origin+path and accepted every one of these.
    for (const url of [
      "https://evil.example/morgen/app.html",
      "https://morgen.so.evil.example/app.html",
      "https://cdn.example/assets/morgen/app.html",
      "http://localhost:8080/morgen/app.html",
      "chrome-extension://abc/app/app.html",
    ]) {
      expect(classifyTarget({ type: "page", url })).toBeNull();
    }
  });

  test("the real desktop app still classifies — a false negative breaks auth", () => {
    expect(classifyTarget({ type: "page", url: "morgen://./app.html" })).toBe("electron");
    expect(
      classifyTarget({ type: "page", url: "file:///opt/Morgen/resources/app.html" })
    ).toBe("electron");
  });

  test("an impostor never outranks the real tab", () => {
    const ranked = rankTargets([
      { type: "page", url: "https://evil.example/morgen/app.html" },
      { type: "page", url: "https://web.morgen.so/" },
    ]);
    expect(ranked[0]?.source).toBe("chrome");
    expect((ranked[0]?.target as any).url).toBe("https://web.morgen.so/");
  });

  test("classifyTarget inherits the hardening", () => {
    expect(classifyTarget({ type: "page", url: "https://morgen.so.evil.example/" })).toBeNull();
    expect(classifyTarget({ type: "page", url: "https://web.morgen.so/" })).toBe("chrome");
  });
});
