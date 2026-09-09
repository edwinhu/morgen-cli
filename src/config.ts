/**
 * User config: ~/.config/morgen-cli/config.json (XDG_CONFIG_HOME honoured).
 *
 * Deliberately its own file. session.json is rewritten on every re-auth and
 * firebase.json holds credentials; preferences in either would be destroyed or
 * leaked.
 *
 *   { "calendars": { "include": ["Calendar", "Gmail"], "exclude": ["Family"] } }
 *
 * Entries match calendar names by case-insensitive full-name equality, NOT the
 * substring matching the --calendars/--exclude-calendars flags use.
 */
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

export interface CalendarConfig {
  /** Allowlist: when present, only these calendars are visible. */
  include?: string[];
  /** Denylist, applied after `include`. */
  exclude?: string[];
}

export interface MorgenConfig {
  calendars?: CalendarConfig;
}

export function configPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(base, "morgen-cli", "config.json");
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`\`${label}\` must be an array of strings`);
  }
  return value as string[];
}

/**
 * Read the config. A missing file yields {}. A malformed one warns and yields
 * {} — never throws, so a bad config degrades to today's behaviour (all
 * calendars) instead of aborting the command.
 */
export function loadConfig(
  warn: (message: string) => void = (m) => process.stderr.write(`${m}\n`)
): MorgenConfig {
  const path = configPath();
  if (!existsSync(path)) return {};

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object at the top level");
    }
    const cals = (parsed as Record<string, unknown>).calendars;
    if (cals === undefined) return {};
    if (typeof cals !== "object" || cals === null || Array.isArray(cals)) {
      throw new Error("`calendars` must be an object");
    }
    const raw = cals as Record<string, unknown>;
    const out: CalendarConfig = {};
    if (raw.include !== undefined) {
      out.include = stringArray(raw.include, "calendars.include");
    }
    if (raw.exclude !== undefined) {
      out.exclude = stringArray(raw.exclude, "calendars.exclude");
    }
    return { calendars: out };
  } catch (e) {
    warn(
      `warning: ignoring malformed config ${path}: ${
        e instanceof Error ? e.message : String(e)
      } — showing all calendars`
    );
    return {};
  }
}

export function hasCalendarConfig(config: MorgenConfig): boolean {
  const c = config.calendars;
  return !!c && (c.include !== undefined || c.exclude !== undefined);
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Split calendars into what the config makes visible and what it hides.
 * `include` runs first (allowlist), then `exclude` (denylist).
 */
export function applyCalendarConfig<T extends { name: string }>(
  calendars: T[],
  config: CalendarConfig
): { visible: T[]; hidden: T[] } {
  const include = config.include?.map(norm);
  const exclude = config.exclude?.map(norm);

  const visible: T[] = [];
  const hidden: T[] = [];
  for (const cal of calendars) {
    const name = norm(cal.name);
    const allowed =
      (include === undefined || include.includes(name)) &&
      !(exclude !== undefined && exclude.includes(name));
    (allowed ? visible : hidden).push(cal);
  }
  return { visible, hidden };
}
