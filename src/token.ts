// The sidebar token, inherited from the gh-pr plugin this one replaces.
//
// It answers a different question from the pane: "what is the PR for the branch
// in *this* pane?" rather than "what is the state of everything I have open?".
// Both surfaces use the same glyphs so they can never appear to disagree.

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

const CI_GLYPH: Record<TokenCi, string> = {
  pass: "✓",
  fail: "✗",
  pending: "●",
  none: "",
};

/** Shown in place of the CI glyph while a lookup is in flight, so the sidebar
 * visibly acknowledges the work instead of appearing stuck. */
export const REFRESHING = "⟳";
export const DRAFT = "◌";

export interface TokenState {
  number: number;
  ci: TokenCi;
  isDraft: boolean;
}

/** `◌#21288 ✓` — draft marker, number, CI glyph. */
export function tokenLabel(s: TokenState): string {
  const glyph = CI_GLYPH[s.ci];
  return `${s.isDraft ? DRAFT : ""}#${s.number}${glyph ? ` ${glyph}` : ""}`;
}

/** Keep the number on screen while a refresh runs; only the glyph changes. */
export function refreshingLabel(previous: string | undefined, isDraft = false): string | null {
  const n = parsePrNumber(previous);
  if (n == null) return null;
  return `${isDraft ? DRAFT : ""}#${n} ${REFRESHING}`;
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
