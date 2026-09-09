/**
 * T4 — Open Invites stop hardcoding a zone.
 *
 * This path is Firestore-backed and needs a live Firebase session, so nothing
 * here calls it: creating a real Open Invite is exactly what a test must not do.
 * The observable surface is the source itself — no IANA literal survives, and
 * both the create and the list path go through the shared resolver.
 */
import { describe, it, expect } from "bun:test";
import { resolve, dirname } from "path";
import { readFileSync } from "fs";

const SOURCE_PATH = resolve(dirname(import.meta.path), "..", "open-invite.ts");
const source = readFileSync(SOURCE_PATH, "utf8");

/** "Region/City" string literals — the shape of a hardcoded IANA zone. */
const IANA_LITERAL = /["'`](?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_+-]+["'`]/g;

describe("src/open-invite.ts zone handling", () => {
  it("hardcodes no IANA zone literal", () => {
    expect(source.match(IANA_LITERAL) ?? []).toEqual([]);
  });

  it("resolves the create-path zone through the shared resolver", () => {
    // Booleans rather than toContain/toMatch: a failed string assertion here
    // would print the whole module.
    expect(source.includes("resolveDisplayTimeZone")).toBe(true);
    // The resolver has to come from the shared time module, not be re-declared.
    expect(
      /import\s*\{[^}]*resolveDisplayTimeZone[^}]*\}\s*from\s*["']\.\/time["']/.test(source),
    ).toBe(true);
    expect(source.includes("resolveDisplayTimeZone(input.timeZone)")).toBe(true);
  });

  it("converts listed slot boundaries instead of emitting the raw payload", () => {
    // The old shape handed Firestore's predefinedSlots straight through, so the
    // boundaries carried whatever the document happened to store.
    expect(source.includes("slots: bo.predefinedSlots || []")).toBe(false);
  });
});
