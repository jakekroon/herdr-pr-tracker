// The sidebar token: the PR for the branch in this pane.

import { type GlyphSet, type Glyphs, glyphsFor } from "./glyphs.ts";

/** Buckets `gh pr checks --json bucket` reports. */
export type Bucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export type TokenCi = "pass" | "fail" | "pending" | "none";

/** Worst news first. `cancel` is not a failure, as in the pane. */
export function rollupBuckets(buckets: string[]): TokenCi {
  if (buckets.length === 0) return "none";
  const set = new Set(buckets);
  if (set.has("fail")) return "fail";
  if (set.has("pending")) return "pending";
  if (set.has("pass")) return "pass";
  return "none";
}

/** `none` is not in the glyph set: the pane pads it to keep its columns
 * aligned, and the token has nothing to align. */
function ciMark(ci: TokenCi, g: Glyphs): string {
  return ci === "none" ? "" : g.ci[ci];
}

export interface TokenState {
  number: number;
  ci: TokenCi;
  isDraft: boolean;
}

/** `◌#21288 ✓`: draft marker, number, CI glyph. */
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

export function parsePrNumber(label: string | null | undefined): number | null {
  const m = label?.match(/#(\d+)\b/);
  return m ? Number(m[1]) : null;
}

/** Prefer `cwd`: an agent's `foreground_cwd` can be a sandbox path outside
 * any git repository. */
export function resolvePaneCwd(pane: { cwd?: string; foreground_cwd?: string }): string | undefined {
  return pane.cwd ?? pane.foreground_cwd;
}
