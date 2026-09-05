// The sidebar token, inherited from the gh-pr plugin this one replaces.
//
// It answers a different question from the pane: "what is the PR for the branch
// in *this* pane?" rather than "what is the state of everything I have open?".
// Both surfaces use the same glyphs so they can never appear to disagree.

import { type GlyphSet, type Glyphs, glyphsFor } from "./glyphs.ts";

/** Buckets `gh pr checks --json bucket` reports. */
export type Bucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export type TokenCi = "pass" | "fail" | "pending" | "none";

/**
 * Collapse gh's per-check buckets into one, worst news first.
 *
 * `cancel` is not a failure — the same rule the pane applies to CANCELLED
 * conclusions. This is a deliberate divergence from gh-pr, which treated a
 * cancelled run as red; a cancelled run is nearly always one you superseded.
 */
export function rollupBuckets(buckets: string[]): TokenCi {
  if (buckets.length === 0) return "none";
  const set = new Set(buckets);
  if (set.has("fail")) return "fail";
  if (set.has("pending")) return "pending";
  if (set.has("pass")) return "pass";
  // Everything was skipped or cancelled: no news, rather than a claimed pass.
  return "none";
}

/** The marks come from `src/glyphs.ts`, the same source the pane draws from,
 * so the two surfaces cannot end up meaning different things by one glyph.
 *
 * `none` is the one state they genuinely differ on and so is not in the set:
 * the pane reserves a column for a build result whether or not there is one,
 * to keep its cluster aligned down the page, and the sidebar — one token wide,
 * with nothing to align against — spends nothing. */
function ciMark(ci: TokenCi, g: Glyphs): string {
  return ci === "none" ? "" : g.ci[ci];
}

export interface TokenState {
  number: number;
  ci: TokenCi;
  isDraft: boolean;
}

/** `◌#21288 ✓` — draft marker, number, CI glyph. */
export function tokenLabel(s: TokenState, glyphs?: GlyphSet): string {
  const g = glyphsFor(glyphs);
  const glyph = ciMark(s.ci, g);
  return `${s.isDraft ? g.draft : ""}#${s.number}${glyph ? ` ${glyph}` : ""}`;
}

/** Keep the number on screen while a refresh runs; only the glyph changes. */
export function refreshingLabel(
  previous: string | undefined,
  isDraft = false,
  glyphs?: GlyphSet,
): string | null {
  const n = parsePrNumber(previous);
  if (n == null) return null;
  const g = glyphsFor(glyphs);
  return `${isDraft ? g.draft : ""}#${n} ${g.refreshing}`;
}

/** Recover the PR number from a label we previously wrote. */
export function parsePrNumber(label: string | null | undefined): number | null {
  const m = label?.match(/#(\d+)\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Which working directory to ask git about.
 *
 * Prefer `cwd` — the shell's directory, i.e. the project root the pane was
 * launched in — over `foreground_cwd`, which for an agent like Claude Code can
 * be a transient sandbox path with no git repo in it at all.
 */
export function resolvePaneCwd(pane: { cwd?: string; foreground_cwd?: string }): string | undefined {
  return pane.cwd ?? pane.foreground_cwd;
}
