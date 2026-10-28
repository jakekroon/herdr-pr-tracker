// Both sets mark the same facts in the same cells. Write private-use marks as
// `\u{...}` escapes: a literal is invisible in a diff, a grep, or an editor
// without the font.

import type { CiState, ReviewDecision } from "./model.ts";

export type GlyphSet = "unicode" | "nerd";

export const GLYPH_SETS = ["unicode", "nerd"] as const;

/** The nerd set is opt-in: without the font, a private-use glyph is a blank cell. */
export const DEFAULT_GLYPHS: GlyphSet = "unicode";

/** Excludes `none`: the pane reserves a column for it and the sidebar does not. */
export type Ci = Exclude<CiState, "none">;
export type Review = Exclude<ReviewDecision, null>;

export interface Glyphs {
  ci: Record<Ci, string>;
  review: Record<Review, string>;
  /** The head cannot be merged without a manual resolution. */
  conflict: string;
  /** A Herdr workspace is open on this branch. */
  linked: string;
  draft: string;
  /** An inbound row nobody asked you to look at. */
  involved: string;
  /** Precedes the unresolved-thread count. */
  unresolved: string;
  /** The standing-configuration-problem line under the list. */
  notice: string;
  /** Sidebar only: a lookup is in flight. */
  refreshing: string;
  /** Pane only: a fetch succeeded and the list is empty. The nerd set's
   * uniqueness test refuses a reuse of `ci.pass` here. */
  clear: string;
}

/**
 * GitHub's Octicons, from the Nerd Fonts block `f400`..`f533`. Each codepoint
 * is the same in Nerd Fonts 3.4.0 and 3.5.1 (see `tests/fixtures/octicons.json`).
 * Ghostty embeds 3.4.0, so it needs no installed font.
 */
const NERD: Glyphs = {
  ci: {
    pass: "\u{f42e}", // nf-oct-check
    fail: "\u{f467}", // nf-oct-x
    pending: "\u{f444}", // nf-oct-dot_fill
  },
  review: {
    // Circled, so a review mark differs from a build mark. The unicode set
    // uses `✓` and `✗` for both.
    APPROVED: "\u{f49e}", // nf-oct-check_circle
    CHANGES_REQUESTED: "\u{f52f}", // nf-oct-x_circle
    REVIEW_REQUIRED: "\u{f441}", // nf-oct-eye
  },
  conflict: "\u{f4f4}", // nf-oct-no_entry
  linked: "\u{f418}", // nf-oct-git_branch
  draft: "\u{f4dd}", // nf-oct-git_pull_request_draft
  involved: "\u{f41f}", // nf-oct-comment
  unresolved: "\u{f442}", // nf-oct-comment_discussion
  notice: "\u{f421}", // nf-oct-alert
  refreshing: "\u{f46a}", // nf-oct-sync
  clear: "\u{f45e}", // nf-oct-checklist
};

/**
 * The CI marks match the gh-pr plugin, so `✓` means the same in both while both
 * are installed. That is why this set keeps the review/build collision.
 */
const UNICODE: Glyphs = {
  ci: {
    pass: "✓",
    fail: "✗",
    pending: "●",
  },
  review: {
    APPROVED: "✓",
    CHANGES_REQUESTED: "✗",
    REVIEW_REQUIRED: "◆",
  },
  conflict: "⊘",
  linked: "▪",
  draft: "◌",
  /** The same shape as `linked`, hollow. */
  involved: "◦",
  unresolved: "⚑",
  notice: "⚠",
  refreshing: "⟳",
  /** `✓` again. It stands alone on an empty pane, so the reuse is harmless. */
  clear: "✓",
};

const SETS: Record<GlyphSet, Glyphs> = { unicode: UNICODE, nerd: NERD };

export function glyphsFor(set: GlyphSet = DEFAULT_GLYPHS): Glyphs {
  return SETS[set];
}

export function isGlyphSet(v: string): v is GlyphSet {
  return (GLYPH_SETS as readonly string[]).includes(v);
}

/**
 * Every mark in a set, flattened and keyed by path. The tests use it so a mark
 * added later falls under the whole-set invariants without a test change.
 */
export function marksOf(g: Glyphs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(g) as [string, string | Record<string, string>][]) {
    if (typeof value === "string") out[key] = value;
    else for (const [k, v] of Object.entries(value)) out[`${key}.${k}`] = v;
  }
  return out;
}
