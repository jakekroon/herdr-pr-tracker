// Configuration is deliberately small. What a row *means* is not configurable:
// precedence, colour and sort order are fixed, because a widget whose meaning
// depends on settings is a widget you have to remember the settings of before
// you can read it.
//
// `GLYPHS` is not an exception to that rule, and is worth saying why. It
// chooses a typeface for the marks, not a vocabulary: both sets answer the same
// questions in the same cells at the same widths, and a reader who knows what a
// row means in one knows what it means in the other. It exists because the
// marks are only drawable if the terminal's font has them — of the eleven,
// Monaco, macOS's default, has exactly one — so the set is a fact about the
// machine rather than a preference about the widget. `COLOR` is off the same
// shelf: it turns escapes off for a surface that cannot show them.

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
  /** Which set of marks the pane and the sidebar draw. */
  glyphs: GlyphSet;
  /** Minimum seconds between per-pane sidebar-token lookups. */
  tokenThrottleSeconds: number;
  /** Repositories and owners whose pull requests are never fetched, in either
   * view. */
  ignore: IgnoreEntry[];
  /** Ignore entries the parser refused, verbatim. Carried on the config rather
   * than warned about here so the pure layer stays pure and only the pane —
   * not the sidebar token, which shares this loader — does the complaining. */
  ignoreDropped: string[];
  /** Authors whose pull requests are never fetched, in either view. Its own
   * field rather than more of `ignore`, so a config file that sets only one of
   * the two keys does not reset the other when `loadConfig` merges files. */
  ignoreAuthors: IgnoreEntry[];
  /** Author entries the parser refused, verbatim. */
  ignoreAuthorsDropped: string[];
  /** Pull requests with no update in this many days are never fetched, in
   * either view. `null` is no cutoff. */
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

// A GitHub login: alphanumerics and hyphens, never starting or ending with a
// hyphen, and at most 39 characters. Deliberately no tighter than that — GitHub
// also forbids consecutive hyphens, but a login that merely does not exist is
// already an accepted failure of this feature (it subtracts nothing), so the
// rule here only has to catch what is *certainly* not a login.
//
// A repository name additionally allows dots and underscores, and may begin with
// one — `.github` is a real repository. `.` and `..` are not names, though.
const VALID_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const VALID_REPO_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/**
 * Split `IGNORE_REPOS` into entries, refusing anything ambiguous.
 *
 * Whitespace *and* commas separate, because neither character is legal in an
 * owner or a repository name, so accepting both costs no ambiguity and stops a
 * comma-typing user from ignoring nothing.
 *
 * The slash carries the meaning: `acme/web-app` is one repository, `acme/` is
 * every repository under `acme`, and a bare `web-app` is an **error**. That last
 * one is the point of the syntax rather than pedantry — GitHub answers both
 * `-repo:web-app` and `-user:web-app` by subtracting nothing and reporting no
 * error, so a parser that guessed which was meant would produce a filter that
 * silently does not filter. URLs fail the same test, on the same grounds: one
 * accepted paste-shape invites a queue of them.
 *
 * Duplicates collapse case-insensitively, because GitHub's qualifiers are
 * case-insensitive and two spellings of one repository are one ignore. Refusals
 * collapse the same way, so one mistake is reported once.
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

/** The noun that agrees with the count. Shared by both sentences below rather
 * than derived twice: they say one fact at two lengths, and two copies of the
 * plural rule is two places for them to stop agreeing. */
function entryNoun(n: number): string {
  return n === 1 ? "entry" : "entries";
}

/**
 * What to say about ignore entries the parser refused, or null when there is
 * nothing to say.
 *
 * Pure, and here rather than in the pane, for the reason `src/view.ts` gives for
 * living outside `state.ts`: the pane is the I/O layer the tests never exercise,
 * so a sentence composed there is a sentence that can never go red.
 */
export function ignoreWarning(
  dropped: readonly string[],
  key: IgnoreKey = "IGNORE_REPOS",
): string | null {
  if (dropped.length === 0) return null;
  return `dropped ${dropped.length} malformed ${key} ` +
    `${entryNoun(dropped.length)} (${dropped.join(", ")}) — ${HINT[key]}`;
}

/** The config keys that carry an ignore list. */
export type IgnoreKey = "IGNORE_REPOS" | "IGNORE_AUTHORS";

const HINT: Record<IgnoreKey, string> = {
  IGNORE_REPOS: `each needs an owner: "owner/name", or ` +
    `"owner/" for every repository under one owner`,
  IGNORE_AUTHORS: `each must be a login, "name[bot]", or "app/name"`,
};

/**
 * The same refusal, short enough for the pane.
 *
 * Two sentences for one fact, deliberately: `ignoreWarning` names the offending
 * entries because stderr has room for them, and the pane has tens of columns —
 * so the line that has to fit there says only how many, and leaves the reader to
 * the config file for which. Both count the same list, so they cannot disagree
 * about whether there is a problem.
 */
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

/** Parse `KEY=value` lines. Shell-shaped so the file is interchangeable with
 * the `config`/`config.example` convention the sibling plugin established. */
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
  // Strict, and silent about a refusal: an unknown name leaves the key out of
  // the partial entirely, so the default survives. Drawing blank cells because
  // a name was misspelled is the one outcome worth ruling out.
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

/**
 * Read the repo-root `config` first, then the plugin config dir — the second
 * wins, so a linked development checkout can be overridden by the installed
 * config without editing the tree.
 */
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
