// The other pure layer: rows in, terminal lines out. No I/O, no clock — the
// caller passes `now`, so every width, truncation and colour rule below is
// deterministic and tested offline by tests/render.test.ts.

import {
  type CiState,
  headline,
  type PrRow,
  type ReviewDecision,
  type Signal,
} from "./model.ts";
import { DEFAULT_VIEW, otherView, SWITCHER_LABELS, type View, viewUrl } from "./view.ts";

const ESC = "\x1b";
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
/** Normal intensity — ends bold *and* dim, and nothing else. Every intensity
 * run closes with this rather than a full reset: a reset also drops the
 * colour the run sits inside, so closing a dim stamp mid-line used to strip
 * the colour from everything after it. */
const NORMAL = `${ESC}[22m`;

// Named ANSI-16 only, never 256-colour or truecolour: the pane inherits the
// user's Herdr theme (nord, here) instead of fighting it with hardcoded hex.
const FG: Record<string, string> = {
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  default: `${ESC}[39m`,
};

/** A clean, ready-for-review PR is deliberately uncoloured: if every row is
 * coloured, the colour tells you nothing. */
export const SIGNAL_COLOUR: Record<Signal, keyof typeof FG> = {
  conflict: "red",
  "changes-requested": "red",
  "checks-failed": "red",
  unresolved: "yellow",
  "review-required": "magenta",
  "checks-pending": "blue",
  approved: "green",
  clean: "default",
};

/**
 * The signals loud enough to earn bold as well as colour.
 *
 * Emphasis is a second axis rather than another colour: the palette is the
 * user's theme and must not grow, but "a human asked for changes" and "CI is
 * red" should still separate themselves from the merely yellow rows at a
 * glance. It is also what the header counts as needing you.
 *
 * In precedence order, because `repoHeader` takes the first hit as the group's
 * loudest. `conflict` is the purest case of what this list selects for: nobody
 * else can resolve it and nothing else about the pull request can proceed
 * until somebody does.
 */
export const LOUD: Signal[] = [
  "conflict",
  "changes-requested",
  "checks-failed",
  "unresolved",
];

// CI glyphs are inherited verbatim from the gh-pr plugin this replaces, so the
// two surfaces never disagree about what ✓ means while both are installed.
const CI_GLYPH: Record<CiState, string> = {
  pass: "✓",
  fail: "✗",
  pending: "●",
  none: " ",
};

const REVIEW_GLYPH: Record<Exclude<ReviewDecision, null>, string> = {
  APPROVED: "✓",
  CHANGES_REQUESTED: "✗",
  REVIEW_REQUIRED: "◆",
};

/** The head cannot be merged into the base without a manual resolution.
 * Circle-based like `◌`/`◦`/`◆` rather than another cross: `✗` already means
 * two different things in this cluster (a review and a build), and a third
 * would make the column the only thing telling them apart. `⇄` was unavailable
 * — the narrow switcher label already owns it. */
export const CONFLICT_GLYPH = "⊘";

/** Marks a PR that has a live Herdr workspace open on its branch. */
export const LINKED_GLYPH = "▪";
export const DRAFT_GLYPH = "◌";
/** Marks an inbound row nobody asked you to look at — assigned, mentioned, or
 * you left a comment. Silent for a reviewer row, which is the ordinary reason
 * to be in the view. Geometric like the rest of the set, and paired with `▪`
 * on purpose: it is the same shape, hollow. */
export const INVOLVED_GLYPH = "◦";
export const ELLIPSIS = "…";
/** The dim filler that carries a repository heading out to the right edge, so
 * a group reads as a band rather than as one more line of text. */
export const RULE = "─";
/** Columns before a repo name: workspace marker, draft marker, separator.
 * The header and markers indent to match so everything shares a left edge. */
export const LEAD_WIDTH = 3;

/** The inbound view carries one more mark, so its lead is one column wider.
 * Varying by view is safe where varying by row would not be: the view is
 * whole-pane state, so every row in a single paint agrees. */
export function leadWidth(view: View = DEFAULT_VIEW): number {
  return view === "inbound" ? LEAD_WIDTH + 1 : LEAD_WIDTH;
}

const indentFor = (o: RenderOpts) => " ".repeat(leadWidth(o.view));
/** A title line narrower than this is not worth an age stamp: the stamp would
 * be eating columns the title needs more. */
const MIN_TITLE = 12;

export interface RenderOpts {
  cols: number;
  rows: number;
  /** Milliseconds since the epoch, supplied so rendering stays pure. */
  now: number;
  /** When the displayed data was fetched; null before the first success. */
  fetchedAt: number | null;
  /** Why the last refresh failed, if it did. Shown in the header. */
  error?: string | null;
  pollSeconds: number;
  colour: boolean;
  /** Show `owner/repo` instead of `repo`. */
  showOwner: boolean;
  /** PRs matching the search but not fetched (the `first:` cap). */
  omitted?: number;
  /** Which pull requests the pane is listing. Defaults to the authored view,
   * so every existing caller means what it always did. */
  view?: View;
  /** One line per PR instead of two — the title line is dropped and its
   * hyperlink moves onto the branch. Set by `render` when the full layout
   * would not fit; never chosen by the caller. */
  compact?: boolean;
  /** Something wrong with the configuration, said under the list. Not a failed
   * refresh — that goes in the header, where it belongs to the age it
   * qualifies. This is a standing problem the reader has to go and fix. */
  notice?: string | null;
}

function paint(text: string, colour: keyof typeof FG, on: boolean): string {
  if (!on || colour === "default") return text;
  return `${FG[colour]}${text}${FG.default}`;
}

function dim(text: string, on: boolean): string {
  return on ? `${DIM}${text}${NORMAL}` : text;
}

/** Code points, not UTF-16 units — an emoji in a PR title must not count as
 * two columns and shift the glyph cluster off the right edge. Genuinely
 * double-width CJK is still counted as one; that is a known limitation.
 *
 * A variation selector is the one case handled explicitly, because it is the
 * one that changes a glyph's width rather than its shape: U+FE0F asks for
 * emoji presentation, which is two columns, and counting it as a code point of
 * its own is exactly the extra column it costs. U+FE0E asks for text
 * presentation — one column — so it is stripped. */
export function width(s: string): number {
  // Strip SGR colour runs and OSC 8 hyperlink wrappers — both occupy zero
  // columns, and a measurement that counts them lays the row out short.
  const bare = s
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
    .replace(/︎/g, "");
  return [...bare].length;
}

function clip(s: string, max: number): string {
  if (max <= 0) return "";
  const cp = [...s];
  if (cp.length <= max) return s;
  if (max === 1) return ELLIPSIS;
  return cp.slice(0, max - 1).join("") + ELLIPSIS;
}

/** OSC 8 hyperlink. Herdr's renderer carries hyperlinks per cell and would
 * resolve the click itself, but this pane claims the mouse, so it no longer
 * gets the chance: a click here is decoded by `src/mouse.ts`, located in the
 * painted frame by `hitTargets`, and opened by `src/open.ts`. The escape is
 * still what marks a span as clickable — the hit map is derived from it. */
export function link(url: string, text: string, on: boolean): string {
  if (!on || !url) return text;
  return `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
}

/** A clickable span of a painted frame: the visible columns some hyperlink
 * covers on some line. Rows and columns are 1-based, matching the mouse
 * reports they are compared against. */
export interface HitTarget {
  row: number;
  /** First and last visible column, inclusive. */
  from: number;
  to: number;
  url: string;
}

/**
 * Where the links are in a frame that has already been rendered.
 *
 * Derived from the painted lines rather than computed alongside them, which is
 * the point: **whatever is hyperlinked is clickable, by construction.** A second
 * function that re-derived the layout would be a copy that drifts, and the
 * failure mode of a drifted hit map — a click that opens the wrong pull request
 * — is silent.
 *
 * The walk has to skip escapes the way `width` does, but it cannot use `width`
 * on the whole line: it needs the running column at the point each hyperlink
 * opens and closes, not the total.
 */
export function hitTargets(lines: string[]): HitTarget[] {
  const out: HitTarget[] = [];
  const OPEN = `${ESC}]8;;`;
  const ST = `${ESC}\\`;
  lines.forEach((line, i) => {
    let col = 1;
    let url: string | null = null;
    let from = 1;
    let j = 0;
    while (j < line.length) {
      if (line[j] !== ESC) {
        // A visible run: everything up to the next escape.
        const next = line.indexOf(ESC, j);
        const chunk = next === -1 ? line.slice(j) : line.slice(j, next);
        col += width(chunk);
        j += chunk.length;
        continue;
      }
      if (line.startsWith(OPEN, j)) {
        const end = line.indexOf(ST, j);
        // An unterminated OSC 8 is a truncation bug upstream; the rest of the
        // line is not trustworthy, so stop rather than guess where it ended.
        if (end === -1) break;
        const href = line.slice(j + OPEN.length, end);
        if (href) {
          url = href;
          from = col;
        } else if (url) {
          if (col > from) out.push({ row: i + 1, from, to: col - 1, url });
          url = null;
        }
        j = end + ST.length;
        continue;
      }
      const sgr = /^\x1b\[[0-9;]*m/.exec(line.slice(j));
      j += sgr ? sgr[0].length : 1;
    }
    if (url && col > from) out.push({ row: i + 1, from, to: col - 1, url });
  });
  return out;
}

/**
 * The target under a click, or null.
 *
 * Columns are inclusive at both ends: the last column of a link is part of it.
 */
export function hitAt(targets: HitTarget[], row: number, col: number): HitTarget | null {
  return targets.find((t) => t.row === row && col >= t.from && col <= t.to) ?? null;
}

/** The right-hand status cluster, fixed-width so it aligns down the pane.
 * Returns the plain glyphs and their painted form separately, because the
 * caller needs the visible width to lay out the line. */
function cluster(row: PrRow, colour: boolean): { plain: string; painted: string } {
  const flag = row.unresolved > 0
    ? `⚑${row.unresolvedCapped ? "99+" : String(row.unresolved)}`
    : "";
  // 4 columns holds ⚑ plus a three-digit count or the 99+ floor.
  const flagCell = flag.padEnd(4, " ");
  const reviewCell = row.review ? REVIEW_GLYPH[row.review] : " ";
  const ciCell = CI_GLYPH[row.ci];
  // Reserved on every row whether or not it conflicts, so the cluster keeps
  // aligning down the pane — the same trade the band's count cell makes. It
  // costs two columns of branch name on every row in both views, which is what
  // alignment is worth here. Leftmost rather than at the pane edge: the review
  // and CI cells have held the last two columns since the plugin this one
  // replaces, and moving what lives at the edge would cost more than the
  // columns do.
  const conflictCell = row.conflict ? CONFLICT_GLYPH : " ";

  // Two columns, not one: every other glyph in this cluster is separated from
  // its neighbour — the review cell by an explicit space, the CI cell by the
  // flag cell's padding — so a conflict cell butted straight against the review
  // cell read as one crowded pair beside three evenly spaced ones. The
  // separator is what makes the cluster scan as a row of cells rather than a
  // string of glyphs.
  const plain = `${conflictCell} ${reviewCell} ${flagCell}${ciCell}`;
  if (!colour) return { plain, painted: plain };

  const reviewColour: keyof typeof FG = row.review === "APPROVED"
    ? "green"
    : row.review === "CHANGES_REQUESTED"
    ? "red"
    : row.review === "REVIEW_REQUIRED"
    ? "magenta"
    : "default";
  const ciColour: keyof typeof FG = row.ci === "pass"
    ? "green"
    : row.ci === "fail"
    ? "red"
    : row.ci === "pending"
    ? "blue"
    : "default";

  // Cells that are empty stay unpainted: wrapping blank columns in colour codes
  // makes a clean row carry escapes that say nothing. That is why the flag cell
  // is painted conditionally below, and why the conflict cell asks for
  // "default" — `paint` returns an uncoloured string unwrapped.
  const painted = `${paint(conflictCell, row.conflict ? "red" : "default", true)} ` +
    `${paint(reviewCell, reviewColour, true)} ` +
    `${flag ? paint(flagCell, "yellow", true) : flagCell}` +
    `${paint(ciCell, ciColour, true)}`;
  return { plain, painted };
}

/** Frames for the pre-first-fetch spinner. Ten of them, advanced once per
 * second, because the pane repaints once per second: a faster cadence would
 * only ever show every Nth frame and read as a stutter. */
export const SPINNER = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"];

/** Which frame `now` falls on. Pure, so the header stays testable. */
export function spinner(now: number): string {
  return SPINNER[Math.floor(now / 1000) % SPINNER.length]!;
}

export function relativeAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The same scale without the `ago`, for a stamp sitting inside a row where
 * the surrounding line already says what the number is the age of. */
export function compactAge(ms: number): string {
  return relativeAge(ms).replace(" ago", "");
}

/** How old the PR itself is, or "" when GitHub gave no usable timestamp. */
function prAge(row: PrRow, now: number): string {
  const created = Date.parse(row.createdAt);
  return Number.isFinite(created) ? compactAge(now - created) : "";
}

/**
 * Splice the view switcher into a header line, between what the pane is showing
 * and how old it is.
 *
 * The switcher says what it does rather than naming a view — the pane's title
 * is where the current view is named — and is dim and hyperlinked.
 * The pane claims the mouse, so a **plain click** on it lands in `handleClick`,
 * which recognises this URL as its own and switches the view. The URL is still
 * a real GitHub list rather than a private scheme: wherever the capture does
 * not apply — another terminal, a ctrl-click routed to the registered
 * `[[link_handlers]]` entry — the control has to stay something worth
 * clicking. See `viewUrl`.
 *
 * It buys its columns from the line's **slack**, never out of the summary. The
 * summary is what this line exists to say: how many pull requests there are and
 * how old the data on screen is. Clipping that to make room for a control would
 * be the same class of lie the stale-age colour exists to prevent, so a pane too
 * narrow to hold both keeps a shorter label, and one too narrow for even the
 * shortest simply has no switcher — the toggle action and any key bound to it
 * still work.
 *
 * `head` and `tail` are the plain line either side of the insertion point, and
 * are painted separately: the switcher's dim run has to open and close between
 * them, and closing it with NORMAL rather than a reset is what keeps the tail's
 * colour intact (SGR intensity does not nest).
 */
function withSwitcher(head: string, tail: string, colour: keyof typeof FG, o: RenderOpts): string {
  const target = otherView(o.view ?? DEFAULT_VIEW);
  const slack = o.cols - leadWidth(o.view) - width(head) - width(tail);
  // Longest first, and the first that fits wins: a narrow pane gets a control
  // that says less rather than none at all. The cost of a label is the label
  // plus the " · " that separates it from the summary.
  const label = SWITCHER_LABELS.find((l) => width(l) + 3 <= slack);
  if (!label) return paint(head + tail, colour, o.colour);
  return paint(head, colour, o.colour) +
    dim(" · ", o.colour) + link(viewUrl(target), dim(label, o.colour), true) +
    paint(tail, colour, o.colour);
}

/**
 * The one line the pane is never without, so it carries the summary rather
 * than only the clock: how many PRs are open, how many of them are yours to
 * act on, and how old the data on screen is.
 *
 * It never lets stale data pass for fresh: an age past twice the poll interval
 * goes yellow, and a failed refresh goes red and says why, while still showing
 * how old the data on screen actually is.
 */
export function header(rows: PrRow[], o: RenderOpts): string {
  if (o.fetchedAt == null) {
    // A cold start is the one moment the widget has nothing to say, and a
    // static line there is indistinguishable from a hung one. The spinner is
    // the same acknowledgement the sidebar token makes with ⟳.
    // The view is named here too, not only once rows arrive: a cold start in
    // the inbound view is otherwise the same picture as one in the authored
    // view, which is the case naming the mode exists to prevent.
    const loading = o.view === "inbound"
      ? `${spinner(o.now)} loading inbound…`
      : `${spinner(o.now)} loading…`;
    const text = o.error ? o.error : loading;
    const body = clip(text, o.cols - leadWidth(o.view));
    // Nothing has been fetched, so there is no age for the switcher to sit in
    // front of: it goes last, where the timer will be.
    return indentFor(o) + withSwitcher(body, "", o.error ? "red" : "default", o);
  }
  const age = o.now - o.fetchedAt;
  const stale = age > o.pollSeconds * 2000;

  // Counted from the headline signal, which is safe because the four loud
  // signals are also the top four of the precedence order: a row carrying one
  // of them can never have something else as its headline. tests/render.test.ts
  // asserts that prefix, because this count is silently wrong the moment LOUD
  // and PRECEDENCE disagree.
  const total = rows.length + (o.omitted ?? 0);
  // The inbound view names itself, because an empty list is otherwise the same
  // picture in both views, and drops the needs-you count: every row in it needs
  // you by definition, so the number is no information.
  let summary: string;
  if (o.view === "inbound") {
    summary = `${total} inbound`;
  } else {
    const loud = rows.filter((r) => LOUD.includes(headline(r, o.view))).length;
    summary = `${total} open` + (loud > 0 ? ` · ${loud} need you` : "");
  }

  // Split where the switcher goes: after what the pane is showing, before how
  // old it is. Clipping happens on the whole line, so the tail is what gives way
  // on a narrow pane — never the count.
  const tail = o.error
    ? ` · ${relativeAge(age)} — ${o.error}`
    : ` · ${relativeAge(age)}`;
  const text = summary + tail;
  const colour: keyof typeof FG = o.error
    ? "red"
    : stale
    ? "yellow"
    : "default";
  const body = clip(text, o.cols - leadWidth(o.view));
  // A clip that ate into the summary leaves no insertion point, and the whole
  // line is already over budget — so the switcher is not offered at all.
  const head = body.startsWith(summary) ? summary : body;
  return indentFor(o) + withSwitcher(head, body.slice(head.length), colour, o);
}

/** A repo group: one header line and the branches under it. */
export interface RepoGroup {
  owner: string;
  repo: string;
  rows: PrRow[];
}

/**
 * Collect rows under one entry per repository.
 *
 * All of a repository's PRs land under a single header even when they are not
 * adjacent in date order, which is the point of grouping: `web-app` is one
 * heading with six branches, not three headings with two each. Group order is
 * first appearance, which follows whatever order the rows arrived in: the
 * repository whose oldest PR is oldest in the authored view, whose newest is
 * newest in the inbound one. Within a group the rows keep that order, so the
 * `+N older` marker still means what it says at whichever end it sits.
 */
export function groupRows(rows: PrRow[]): RepoGroup[] {
  const groups: RepoGroup[] = [];
  const index = new Map<string, RepoGroup>();
  for (const row of rows) {
    const key = `${row.owner}/${row.repo}`;
    let g = index.get(key);
    if (!g) {
      g = { owner: row.owner, repo: row.repo, rows: [] };
      index.set(key, g);
      groups.push(g);
    }
    g.rows.push(row);
  }
  return groups;
}

/**
 * The repository heading: flush left, so the branches indented under it read
 * as its children, and carried out to the right edge by a dim rule so a group
 * is a visible band rather than one more line of text at the same weight as a
 * truncated title. Dim throughout, because it is a label rather than a signal.
 */
export function repoHeader(g: RepoGroup, o: RenderOpts): string {
  const name = `${o.showOwner ? `${g.owner}/` : ""}${g.repo}`;
  const text = clip(name, o.cols);

  // How many of this group's PRs are yours to act on — the same count the
  // header carries, per repository, so a band says which group wants you
  // without your reading its branches. Coloured by the loudest signal in the
  // group and never dimmed: it is the one part of a heading that is a signal
  // rather than a label. LOUD is in precedence order, so the first hit is the
  // loudest.
  // Suppressed in the inbound view for the same reason the header's count is:
  // every row there needs you, so a per-band tally of them is the group size
  // written twice. The cell below is still reserved, so the rules line up
  // across both views.
  const loud = o.view === "inbound"
    ? []
    : g.rows.filter((r) => LOUD.includes(headline(r, o.view)));
  const badge = loud.length > 0 ? String(loud.length) : "";
  const sig = LOUD.find((x) => loud.some((r) => headline(r, o.view) === x));

  // The cell is reserved whether or not this group fills it, so every rule in
  // the pane ends on the same column: a rule whose length depended on whether
  // a group had anything to act on would make the bands look ragged.
  const cell = Math.max(1, badge.length);
  const rule = o.cols - width(text) - 2 - cell;
  if (rule < 1) return dim(clip(text, o.cols), o.colour);

  const line = dim(`${text} ${RULE.repeat(rule)}`, o.colour);
  if (!badge) return `${line}${" ".repeat(cell + 1)}`;
  const mark = o.colour
    ? `${BOLD}${paint(badge, SIGNAL_COLOUR[sig!], true)}${NORMAL}`
    : badge;
  return `${line} ${mark}`;
}

/**
 * Line one: the branch, its markers and its status cluster, always exactly the
 * pane width. `trailing` is whatever the caller wants to sit between the branch
 * and the cluster — the PR number and age, in compact mode — measured in
 * visible columns so the right edge stays put. Candidates are offered longest
 * first and the first one that fits in the slack is taken, so a narrowing pane
 * sheds the age, then the number, and only ever the branch after that.
 */
function branchLine(
  row: PrRow,
  o: RenderOpts,
  trailing: Array<{ plain: string; painted: string }> = [],
): string {
  const inbound = o.view === "inbound";
  const sig = headline(row, o.view);
  const { plain, painted } = cluster(row, o.colour);

  // Three columns: workspace marker, draft marker, separator — four in the
  // inbound view, which adds the involved mark. Fixed width so identities start
  // on the same column whether or not a row carries any of them, and indented
  // past the repository heading above them.
  const lead = `${row.linked ? LINKED_GLYPH : " "}` +
    `${row.isDraft ? DRAFT_GLYPH : " "}` +
    (inbound ? `${row.reason === "involved" ? INVOLVED_GLYPH : " "}` : "") +
    " ";

  // What the row leads with. Your own branch names are how you think about your
  // own work; somebody else's are not, so an inbound row leads with who wrote
  // it. Whichever of the two is not the identity is offered back as the longest
  // trailing candidate, so it survives wherever there are columns spare.
  const identity = inbound ? row.author : row.branch;
  const spare = inbound && row.branch ? ` ${row.branch}` : "";
  const candidates = spare
    ? [
      ...trailing.map((t) => ({
        plain: `${spare}${t.plain}`,
        painted: `${dim(spare, o.colour)}${t.painted}`,
      })),
      { plain: spare, painted: dim(spare, o.colour) },
      ...trailing,
    ]
    : trailing;

  // Right-align the cluster; the branch gives up columns first, because a
  // truncated branch name is still recognisable but a truncated glyph cluster
  // silently drops a signal. The trailing text never buys its columns from the
  // branch: it appears only in the room the whole branch leaves over, so a
  // narrow pane loses the PR number rather than half the branch name.
  const room = Math.max(0, o.cols - width(lead) - width(plain) - 1);
  const shown = clip(identity, room);
  const fits = candidates.find((t) =>
    t.plain.length > 0 && width(shown) + width(t.plain) <= room
  );

  // Bold is reserved for the loud signals, and never for a draft: the row is
  // already dim as a whole, and bold-inside-dim renders inconsistently. It is
  // also never used in the inbound view, where every row is loud — a list in
  // which everything is emphasised tells you nothing.
  let name = paint(shown, SIGNAL_COLOUR[sig], o.colour);
  if (o.colour && !inbound && !row.isDraft && LOUD.includes(sig)) {
    name = `${BOLD}${name}${NORMAL}`;
  }

  const body = fits ? `${name}${fits.painted}` : name;
  const used = width(shown) + (fits ? width(fits.plain) : 0);
  const gap = " ".repeat(Math.max(1, room - used + 1));
  return `${lead}${o.compact ? link(row.url, body, true) : body}${gap}${painted}`;
}

/** Dim a whole row: a draft is dim including its glyphs, so a draft with
 * failing checks still shows the failure rather than hiding it behind grey.
 *
 * SGR intensity does not nest — there is no "pop one level", only 22, which
 * ends dim outright. So an inner terminator inside the line (the dim PR
 * number a compact row carries) would end the row's dim at that point and
 * leave the status cluster after it at full brightness. Re-opening dim after
 * every inner terminator is what makes the whole row dim again. */
function draftDim(lines: string[], row: PrRow, o: RenderOpts): string[] {
  if (!row.isDraft || !o.colour) return lines;
  return lines.map((l) => {
    const body = l.replaceAll(NORMAL, `${NORMAL}${DIM}`);
    // A terminator at the very end re-opens dim over nothing; drop it.
    const tidy = body.endsWith(DIM) ? body.slice(0, -DIM.length) : body;
    return `${DIM}${tidy}${NORMAL}`;
  });
}

/** The two lines for one PR: its branch, then its number, title and age. */
export function renderRow(row: PrRow, o: RenderOpts): [string, string] {
  const line1 = branchLine(row, { ...o, compact: false });

  // The number lives here rather than on the branch line: it is how a PR is
  // referred to everywhere else, and inside the hyperlink it costs no columns
  // the status cluster wants. The age is the fact the layout had nowhere to
  // put — this is an oldest-first list, so how long a pull request has been
  // sitting is the question it exists to answer.
  const indent = " ".repeat(leadWidth(o.view) + 1);
  const avail = Math.max(0, o.cols - indent.length);
  const age = prAge(row, o.now);
  const stamp = age && avail - age.length - 1 >= MIN_TITLE ? age : "";
  const title = clip(`#${row.number} ${row.title}`,
    avail - (stamp ? stamp.length + 1 : 0));
  let line2 = `${indent}${link(row.url, title, true)}`;
  if (stamp) {
    line2 += " ".repeat(Math.max(1, avail - width(title) - stamp.length)) +
      dim(stamp, o.colour);
  }

  const [a, b] = draftDim([line1, line2], row, o);
  return [a!, b!];
}

/**
 * One line for one PR: the branch line, with the number folded in after the
 * branch and the title's hyperlink moved onto the whole thing. Half the height
 * and none of the signals lost — which is why a pane too short for the full
 * layout compacts before it drops anything.
 */
export function compactRow(row: PrRow, o: RenderOpts): string {
  // The age is the fact compaction used to lose outright: the list is ordered
  // oldest-first precisely so "how long has this been sitting" is answerable,
  // and dropping the title must not drop the answer. It buys its columns from
  // the slack the branch leaves over, never from the branch.
  const num = ` #${row.number}`;
  const age = prAge(row, o.now);
  const both = age ? `${num} ${age}` : num;
  const cell = (t: string) => ({ plain: t, painted: dim(t, o.colour) });
  const line = branchLine(row, { ...o, compact: true },
    both === num ? [cell(num)] : [cell(both), cell(num)]);
  return draftDim([line], row, o)[0]!;
}

/**
 * A standing configuration problem, drawn under the list.
 *
 * Yellow and `⚠` rather than red: the list above it is correct, and what is
 * wrong is something to go and fix rather than a widget that has failed. It
 * cannot be confused with a pull request's own marks — none of them is this
 * glyph, and none of them sits below the last band.
 */
function noticeLine(o: RenderOpts): string | null {
  if (!o.notice) return null;
  const body = clip(`\u26a0 ${o.notice}`, o.cols - leadWidth(o.view));
  if (body.length === 0) return null;
  return indentFor(o) + paint(body.slice(0, 1), "yellow", o.colour) +
    dim(body.slice(1), o.colour);
}

/**
 * The whole pane.
 *
 * When the two-line layout will not fit, the rows are halved before any of
 * them is dropped: a one-line row still carries its branch, its signals and
 * its link, which is strictly more than a row that is not on screen at all.
 * Only when even the compact layout overflows are rows dropped — and then the
 * *oldest* go, with a `… +N older` marker taking the first row, because the
 * list is ordered oldest-first and truncating the tail would silently hide the
 * PRs you opened most recently.
 *
 * How many rows fit is not arithmetic on a fixed row height: dropping a PR can
 * also drop the heading above it and the blank line before it, so the largest
 * suffix that fits is found by measuring, not by dividing.
 */
export function render(rows: PrRow[], o: RenderOpts): string[] {
  // Which end of the list holds the oldest rows. The authored view is ordered
  // oldest-first, the inbound view newest-first, and both drop the *oldest* —
  // so the marker moves with them and always sits next to what it stands for.
  const oldestLast = o.view === "inbound";
  const keptRows = (keep: number) =>
    oldestLast ? rows.slice(0, keep) : rows.slice(rows.length - keep);

  const out: string[] = [header(rows, o)];
  // One blank line under the summary: without it the summary and the first
  // repository heading sit at the same left edge with nothing between them and
  // read as one block. Skipped in a pane too short to spend a line on it.
  if (o.rows > 2) out.push("");

  // The notice sits at the foot of the list, and its line is reserved out of
  // the budget before the rows are measured — so it costs a pull request rather
  // than being clipped off the bottom. That is the right way round: a dropped
  // pull request is counted by `+N older`, and a notice nobody can see is the
  // whole bug this line exists to fix.
  const notice = noticeLine(o);
  const budget = Math.max(0, o.rows - out.length - (notice ? 1 : 0));

  if (rows.length === 0) {
    // The state a good day ends in, so it gets a mark of its own rather than
    // reading like the blank pane of a widget that has failed. The header
    // above already says `0 open`, so this line says the other half.
    //
    // Only once a fetch has actually succeeded, though: before that the list
    // is empty because nothing has been asked yet, and "all clear" under a
    // spinner claims an answer nobody has.
    if (budget > 0 && o.fetchedAt != null) {
      out.push(indentFor(o) + paint("✓", "green", o.colour) + dim(" all clear", o.colour));
    }
    if (notice && out.length < o.rows) out.push(notice);
    return out.slice(0, o.rows);
  }

  // One heading per surviving repository, one blank line between groups, one
  // or two lines per PR, plus the marker line when anything is withheld.
  const cost = (keep: number, compact: boolean): number => {
    const marked = keep < rows.length || (o.omitted ?? 0) > 0;
    const groups = groupRows(keptRows(keep));
    return (marked ? 1 : 0) + Math.max(0, groups.length - 1) +
      groups.reduce((n, g) => n + 1 + (compact ? 1 : 2) * g.rows.length, 0);
  };

  let keep = rows.length;
  let compact = false;
  if (cost(keep, false) > budget) {
    compact = true;
    while (keep > 0 && cost(keep, true) > budget) keep--;
  }
  const ro: RenderOpts = { ...o, compact };

  const dropped = (o.omitted ?? 0) + (rows.length - keep);
  const marker = indentFor(o) +
    paint(`${ELLIPSIS} +${dropped} older`, "default", o.colour);
  if (dropped > 0 && !oldestLast) out.push(marker);

  let first = true;
  for (const g of groupRows(keptRows(keep))) {
    if (!first) out.push("");
    first = false;
    out.push(repoHeader(g, ro));
    for (const row of g.rows) {
      out.push(...(compact ? [compactRow(row, ro)] : renderRow(row, ro)));
    }
  }
  if (dropped > 0 && oldestLast) out.push(marker);
  if (notice) out.push(notice);
  return out.slice(0, o.rows);
}
