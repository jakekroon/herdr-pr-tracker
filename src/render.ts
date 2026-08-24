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
 */
export const LOUD: Signal[] = ["changes-requested", "checks-failed", "unresolved"];

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

/** Marks a PR that has a live Herdr workspace open on its branch. */
export const LINKED_GLYPH = "▪";
export const DRAFT_GLYPH = "◌";
export const ELLIPSIS = "…";
/** The dim filler that carries a repository heading out to the right edge, so
 * a group reads as a band rather than as one more line of text. */
export const RULE = "─";
/** Columns before a repo name: workspace marker, draft marker, separator.
 * The header and markers indent to match so everything shares a left edge. */
export const LEAD_WIDTH = 3;
const INDENT = " ".repeat(LEAD_WIDTH);
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
  /** One line per PR instead of two — the title line is dropped and its
   * hyperlink moves onto the branch. Set by `render` when the full layout
   * would not fit; never chosen by the caller. */
  compact?: boolean;
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

/** OSC 8 hyperlink. Herdr's renderer carries hyperlinks per cell and handles
 * the click itself, so the plugin never has to claim the mouse or shell out to
 * a browser — which is what lets the pane stay keyboard-deaf. */
export function link(url: string, text: string, on: boolean): string {
  if (!on || !url) return text;
  return `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
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

  const plain = `${reviewCell} ${flagCell}${ciCell}`;
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

  // An empty flag cell stays unpainted: wrapping four spaces in colour codes
  // makes a clean row carry escapes that say nothing.
  const painted = `${paint(reviewCell, reviewColour, true)} ` +
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
    const text = o.error ? o.error : `${spinner(o.now)} loading…`;
    return INDENT + paint(clip(text, o.cols - LEAD_WIDTH),
      o.error ? "red" : "default", o.colour);
  }
  const age = o.now - o.fetchedAt;
  const stale = age > o.pollSeconds * 2000;

  // Counted from the headline signal, which is safe because the three loud
  // signals are also the top three of the precedence order: a row carrying one
  // of them can never have something else as its headline.
  const loud = rows.filter((r) => LOUD.includes(headline(r))).length;
  const total = rows.length + (o.omitted ?? 0);
  const summary = `${total} open` + (loud > 0 ? ` · ${loud} need you` : "");

  const text = o.error
    ? `${summary} · ${relativeAge(age)} — ${o.error}`
    : `${summary} · ${relativeAge(age)}`;
  const colour: keyof typeof FG = o.error
    ? "red"
    : stale
    ? "yellow"
    : "default";
  return INDENT + paint(clip(text, o.cols - LEAD_WIDTH), colour, o.colour);
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
 * first appearance — and rows arrive oldest-created first, so that is the
 * repository whose oldest PR is oldest. Within a group the rows keep their
 * date order, so the `+N older` marker still means what it says.
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
  const loud = g.rows.filter((r) => LOUD.includes(headline(r)));
  const badge = loud.length > 0 ? String(loud.length) : "";
  const sig = LOUD.find((x) => loud.some((r) => headline(r) === x));

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
  const sig = headline(row);
  const { plain, painted } = cluster(row, o.colour);

  // Three columns: workspace marker, draft marker, separator. Fixed width so
  // branches start on the same column whether or not a row carries either
  // mark, and indented past the repository heading above them.
  const lead = `${row.linked ? LINKED_GLYPH : " "}` +
    `${row.isDraft ? DRAFT_GLYPH : " "} `;

  // Right-align the cluster; the branch gives up columns first, because a
  // truncated branch name is still recognisable but a truncated glyph cluster
  // silently drops a signal. The trailing text never buys its columns from the
  // branch: it appears only in the room the whole branch leaves over, so a
  // narrow pane loses the PR number rather than half the branch name.
  const room = Math.max(0, o.cols - width(lead) - width(plain) - 1);
  const shown = clip(row.branch, room);
  const fits = trailing.find((t) =>
    t.plain.length > 0 && width(shown) + width(t.plain) <= room
  );

  // Bold is reserved for the loud signals, and never for a draft: the row is
  // already dim as a whole, and bold-inside-dim renders inconsistently.
  let name = paint(shown, SIGNAL_COLOUR[sig], o.colour);
  if (o.colour && !row.isDraft && LOUD.includes(sig)) name = `${BOLD}${name}${NORMAL}`;

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
  const indent = "    ";
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
  const out: string[] = [header(rows, o)];
  // One blank line under the summary: without it the summary and the first
  // repository heading sit at the same left edge with nothing between them and
  // read as one block. Skipped in a pane too short to spend a line on it.
  if (o.rows > 2) out.push("");
  const budget = Math.max(0, o.rows - out.length);

  if (rows.length === 0) {
    // The state a good day ends in, so it gets a mark of its own rather than
    // reading like the blank pane of a widget that has failed. The header
    // above already says `0 open`, so this line says the other half.
    //
    // Only once a fetch has actually succeeded, though: before that the list
    // is empty because nothing has been asked yet, and "all clear" under a
    // spinner claims an answer nobody has.
    if (budget > 0 && o.fetchedAt != null) {
      out.push(INDENT + paint("✓", "green", o.colour) + dim(" all clear", o.colour));
    }
    return out;
  }

  // One heading per surviving repository, one blank line between groups, one
  // or two lines per PR, plus the marker line when anything is withheld.
  const cost = (keep: number, compact: boolean): number => {
    const marked = keep < rows.length || (o.omitted ?? 0) > 0;
    const groups = groupRows(rows.slice(rows.length - keep));
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
  if (dropped > 0) {
    out.push(INDENT + paint(`${ELLIPSIS} +${dropped} older`, "default", o.colour));
  }
  let first = true;
  for (const g of groupRows(rows.slice(rows.length - keep))) {
    if (!first) out.push("");
    first = false;
    out.push(repoHeader(g, ro));
    for (const row of g.rows) {
      out.push(...(compact ? [compactRow(row, ro)] : renderRow(row, ro)));
    }
  }
  return out.slice(0, o.rows);
}
