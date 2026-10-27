// What a row means is fixed: precedence, colour and sort order are not
// settings. `GLYPHS` and `COLOR` only adapt the drawing to what the terminal
// can show.

import { DEFAULT_GLYPHS, type GlyphSet, isGlyphSet } from "./glyphs.ts";
import { join } from "node:path";
import { DEFAULT_SEARCH, type IgnoreEntry } from "./query.ts";

export interface Config {
  pollSeconds: number;
  searchQuery: string;
  maxPrs: number;
  /** "auto" shows the owner only when a PR's owner is not the common one. */
  showOwner: "auto" | "always" | "never";
  colour: boolean;
  glyphs: GlyphSet;
  /** Minimum seconds between per-pane sidebar-token lookups. */
  tokenThrottleSeconds: number;
  /** Repositories and owners excluded from both views. */
  ignore: IgnoreEntry[];
  /** Ignore entries the parser refused, verbatim. The pane reports them; the
   * sidebar token shares this loader and stays silent. */
  ignoreDropped: string[];
  /** Authors excluded from both views. A separate field from `ignore`, because
   * `loadConfig` merges files key by key: a file that sets one key keeps the
   * other. */
  ignoreAuthors: IgnoreEntry[];
  /** Author entries the parser refused, verbatim. */
  ignoreAuthorsDropped: string[];
  /** Exclude pull requests idle for more than this many days. `null` is no cutoff. */
  maxIdleDays: number | null;
}

export const DEFAULTS: Config = {
  pollSeconds: 60,
  searchQuery: DEFAULT_SEARCH,
  maxPrs: 100,
  showOwner: "auto",
  colour: true,
  glyphs: DEFAULT_GLYPHS,
  tokenThrottleSeconds: 30,
  ignore: [],
  ignoreDropped: [],
  ignoreAuthors: [],
  ignoreAuthorsDropped: [],
  maxIdleDays: null,
};

// These reject only what is certainly not a login or a repository name. A
// well-formed name that does not exist subtracts nothing. `.github` is a real
// repository name; `.` and `..` are not.
const VALID_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const VALID_REPO_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/**
 * `acme/web-app` is one repository and `acme/` is every repository under
 * `acme`. A bare `web-app` or a URL is refused: GitHub answers a wrong
 * `-repo:` or `-user:` qualifier by subtracting nothing, with no error.
 * Duplicates collapse case-insensitively, as GitHub's qualifiers do.
 */
function parseIgnoreList(
  raw: string,
): { entries: IgnoreEntry[]; dropped: string[] } {
  return parseList(raw, (token) => {
    const slash = token.indexOf("/");
    const owner = slash < 0 ? "" : token.slice(0, slash);
    const name = slash < 0 ? "" : token.slice(slash + 1);
    const ok = slash >= 0 && VALID_OWNER.test(owner) &&
      (name === "" || VALID_REPO_NAME.test(name));
    if (!ok) return null;
    return name === "" ? { kind: "owner", owner } : { kind: "repo", owner, name };
  });
}

/**
 * Split `IGNORE_AUTHORS` into entries, refusing anything that is not a login.
 *
 * Three shapes, all passed to GitHub verbatim: a user's login, a bot's login
 * with its `[bot]` suffix, and `app/<slug>`. A bot is the trap. GitHub reports
 * Dependabot's login as `dependabot`, but probed against the live API,
 * `-author:dependabot` subtracts nothing and reports no error, while
 * `-author:dependabot[bot]` and `-author:app/dependabot` both subtract it. A
 * bare bot name is a valid login shape, so the parser cannot refuse it.
 *
 * A slash outside `app/` and a leading `@` are refused: the first is an
 * `IGNORE_REPOS` entry in the wrong key, and the second is a paste-shape.
 */
function parseAuthorList(
  raw: string,
): { entries: IgnoreEntry[]; dropped: string[] } {
  return parseList(raw, (token) => {
    const app = /^app\//i.test(token) ? token.slice(4) : null;
    const base = app ?? token.replace(/\[bot\]$/i, "");
    return VALID_OWNER.test(base) ? { kind: "author", login: token } : null;
  });
}

/** The split, dedup and refusal shared by both ignore keys. */
function parseList(
  raw: string,
  entryOf: (token: string) => IgnoreEntry | null,
): { entries: IgnoreEntry[]; dropped: string[] } {
  const entries: IgnoreEntry[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  for (const token of raw.split(/[\s,]+/)) {
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = entryOf(token);
    if (entry) entries.push(entry);
    else dropped.push(token);
  }
  return { entries, dropped };
}

function entryNoun(n: number): string {
  return n === 1 ? "entry" : "entries";
}

/** The stderr warning for refused ignore entries, or null when there are none. */
export function ignoreWarning(
  dropped: readonly string[],
  key: IgnoreKey = "IGNORE_REPOS",
): string | null {
  if (dropped.length === 0) return null;
  return `dropped ${dropped.length} malformed ${key} ` +
    `${entryNoun(dropped.length)} (${dropped.join(", ")}) — ${HINT[key]}`;
}

export type IgnoreKey = "IGNORE_REPOS" | "IGNORE_AUTHORS";

const HINT: Record<IgnoreKey, string> = {
  IGNORE_REPOS: `each needs an owner: "owner/name", or ` +
    `"owner/" for every repository under one owner`,
  IGNORE_AUTHORS: `each must be a login, "name[bot]", or "app/name"`,
};

/** The same warning, short enough for the pane: a count, without the entries. */
export function ignoreNotice(
  dropped: readonly string[],
  key: IgnoreKey = "IGNORE_REPOS",
): string | null {
  if (dropped.length === 0) return null;
  return `${dropped.length} bad ${key} ${entryNoun(dropped.length)}`;
}

/** Both keys' refusals as one pane line, or null when both are clean. The pane
 * has one notice line, so two keys share it rather than one hiding the other. */
export function configNotice(
  cfg: Pick<Config, "ignoreDropped" | "ignoreAuthorsDropped">,
): string | null {
  const parts = [
    ignoreNotice(cfg.ignoreDropped, "IGNORE_REPOS"),
    ignoreNotice(cfg.ignoreAuthorsDropped, "IGNORE_AUTHORS"),
  ].filter((n): n is string => n != null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Both keys' refusals, one stderr line each. */
export function configWarnings(
  cfg: Pick<Config, "ignoreDropped" | "ignoreAuthorsDropped">,
): string[] {
  return [
    ignoreWarning(cfg.ignoreDropped, "IGNORE_REPOS"),
    ignoreWarning(cfg.ignoreAuthorsDropped, "IGNORE_AUTHORS"),
  ].filter((w): w is string => w != null);
}

/** Parse shell-style `KEY=value` lines. */
export function parseConfig(text: string): Partial<Config> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    out[key] = value;
  }

  const cfg: Partial<Config> = {};
  const int = (v: string | undefined, min: number) => {
    if (v == null) return undefined;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= min ? n : undefined;
  };

  const poll = int(out.POLL_SECONDS, 5);
  if (poll != null) cfg.pollSeconds = poll;
  const max = int(out.MAX_PRS, 1);
  if (max != null) cfg.maxPrs = Math.min(max, 100);
  const throttle = int(out.TOKEN_THROTTLE_SECONDS, 0);
  if (throttle != null) cfg.tokenThrottleSeconds = throttle;
  const idle = int(out.MAX_IDLE_DAYS, 1);
  if (idle != null) cfg.maxIdleDays = idle;
  if (out.SEARCH_QUERY) cfg.searchQuery = out.SEARCH_QUERY;
  if (out.SHOW_OWNER === "always" || out.SHOW_OWNER === "never" || out.SHOW_OWNER === "auto") {
    cfg.showOwner = out.SHOW_OWNER;
  }
  // An unknown name keeps the default, so a typo cannot draw blank cells.
  if (out.GLYPHS != null && isGlyphSet(out.GLYPHS)) cfg.glyphs = out.GLYPHS;
  if (out.IGNORE_REPOS != null) {
    const { entries, dropped } = parseIgnoreList(out.IGNORE_REPOS);
    cfg.ignore = entries;
    cfg.ignoreDropped = dropped;
  }
  if (out.IGNORE_AUTHORS != null) {
    const { entries, dropped } = parseAuthorList(out.IGNORE_AUTHORS);
    cfg.ignoreAuthors = entries;
    cfg.ignoreAuthorsDropped = dropped;
  }
  if (out.COLOR != null || out.COLOUR != null) {
    const v = (out.COLOR ?? out.COLOUR)!.toLowerCase();
    cfg.colour = !(v === "0" || v === "off" || v === "false" || v === "no");
  }
  return cfg;
}

/** Read the repo-root `config`, then the plugin config dir. The second wins. */
export async function loadConfig(pluginRoot: string, configDir?: string): Promise<Config> {
  let cfg: Config = { ...DEFAULTS };
  for (const dir of [pluginRoot, configDir]) {
    if (!dir) continue;
    const file = Bun.file(join(dir, "config"));
    if (!(await file.exists())) continue;
    cfg = { ...cfg, ...parseConfig(await file.text()) };
  }
  return cfg;
}
