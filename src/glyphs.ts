// The marks the pane and the sidebar draw, in one place and in two sets.
//
// This is a typeface, not a vocabulary: both sets answer exactly the same
// questions, and precedence, colour and ordering are unchanged by the choice.
// A reader who knows what a row means in one set knows what it means in the
// other — which is the property `config.ts` is protecting when it refuses to
// make meaning configurable.
//
// Every mark is written as an escape rather than as a literal. The nerd set
// lives in a private-use area, where a literal is *invisible* in a diff, in a
// grep and in an editor without the font — and a wrong one there renders as a
// plausible glyph rather than as a mistake.

import type { CiState, ReviewDecision } from "./model.ts";

export type GlyphSet = "unicode" | "nerd";

/** Both sets, in the order the config documents them. */
export const GLYPH_SETS = ["unicode", "nerd"] as const;

/** Unicode, so a widget nobody has configured draws what it always drew. The
 * nerd set is opt-in because it needs a font the machine may not have, and a
 * missing private-use glyph is a blank cell rather than an error. */
export const DEFAULT_GLYPHS: GlyphSet = "unicode";

/** A build result the cluster has something to say about. `none` is not here:
 * the pane reserves a column for it and the sidebar spends none, so the two
 * surfaces genuinely differ and each decides for itself. */
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
  /** Pane only: the whole list is empty and a fetch has succeeded. Its own
   * mark rather than `ci.pass`, because it answers a different question —
   * "nothing needs you" is a property of the pane, not a build result — and
   * the nerd set's uniqueness invariant would refuse the reuse anyway. */
  clear: string;
}

/**
 * Octicons, out of the Nerd Fonts private-use block `f400`–`f533`.
 *
 * Octicons rather than any of the dozen other sets Nerd Fonts carries because
 * this widget is about GitHub and Octicons is GitHub's own icon set, so the
 * marks already mean here what they mean on the page the row links to.
 *
 * Every codepoint below is identical in Nerd Fonts 3.4.0 and 3.5.1 — checked
 * against both tags — which matters because Ghostty embeds Symbols Nerd Font
 * 3.4.0 in its own binary and therefore needs no font installed at all.
 */
const NERD: Glyphs = {
  ci: {
    pass: "\u{f42e}", // nf-oct-check
    fail: "\u{f467}", // nf-oct-x
    pending: "\u{f444}", // nf-oct-dot_fill
  },
  review: {
    // Circled, where the build marks are bare. This is the one thing the
    // unicode set cannot say: there, `✓` is spent on both a passing build and
    // an approval, and `✗` on both a failing build and a request for changes,
    // so the cluster shows which cell it is but not which fact.
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
 * What the widget has always drawn: geometric shapes and dingbats out of the
 * BMP, needing no font anyone has to install.
 *
 * The CI marks are inherited verbatim from the gh-pr plugin this one replaces,
 * so the two surfaces never disagree about what `✓` means while both are
 * installed — which is also why this set keeps the review/build collision the
 * nerd set fixes rather than quietly diverging from gh-pr to fix it.
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
  /** Spends `✓` a third time. Harmless where the cluster's reuse is not: this
   * mark stands alone on an otherwise empty pane, next to the words. */
  clear: "✓",
};

const SETS: Record<GlyphSet, Glyphs> = { unicode: UNICODE, nerd: NERD };

/** The set to draw with. Defaults, so every existing caller means what it
 * always did. */
export function glyphsFor(set: GlyphSet = DEFAULT_GLYPHS): Glyphs {
  return SETS[set];
}

/** Strict, like `isView`: a name the renderer cannot draw is a configuration
 * mistake, and accepting it would paint blank cells with no explanation. */
export function isGlyphSet(v: string): v is GlyphSet {
  return (GLYPH_SETS as readonly string[]).includes(v);
}

/**
 * Every mark in a set, flattened, keyed by what it means.
 *
 * Exists for the tests rather than for the renderer: the invariants worth
 * holding — one code point each, none of them a width the terminal will
 * double, all of the nerd set inside the Octicons block and no two alike — are
 * properties of the *whole* set, and a check that enumerated the fields by
 * hand would silently stop covering a field added later. This derives the list
 * from the object instead.
 */
export function marksOf(g: Glyphs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(g) as [string, string | Record<string, string>][]) {
    if (typeof value === "string") out[key] = value;
    else for (const [k, v] of Object.entries(value)) out[`${key}.${k}`] = v;
  }
  return out;
}
