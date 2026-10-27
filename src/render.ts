// Rows in, terminal lines out. No I/O and no clock: the caller passes `now`.

import { type GlyphSet, type Glyphs, glyphsFor } from "./glyphs.ts";
import { headline, type PrRow, type Signal } from "./model.ts";
import { DEFAULT_VIEW, otherView, SWITCHER_LABELS, type View, viewUrl } from "./view.ts";

const ESC = "\x1b";
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
/** Ends bold and dim. Close every intensity run with this: a full reset also
 * drops the colour the run sits inside. */
const NORMAL = `${ESC}[22m`;

// Named ANSI-16 only, so the pane inherits the user's Herdr theme.
const FG: Record<string, string> = {
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  default: `${ESC}[39m`,
};

/** `clean` stays uncoloured: if every row has a colour, colour tells you nothing. */
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
 * The signals that get bold as well as colour, and that the header counts as
 * needing you. Keep it in precedence order: `repoHeader` takes the first hit
 * as the group's loudest.
 */
export const LOUD: Signal[] = [
  "conflict",
  "changes-requested",
  "checks-failed",
  "unresolved",
];

// Layout punctuation, outside the `GLYPHS` sets: Monaco has both.
export const ELLIPSIS = "…";
export const RULE = "─";
/** Columns before a repo name: workspace marker, draft marker, separator. */
export const LEAD_WIDTH = 3;

/** The inbound view adds the involved mark. Varying by view is safe because
 * every row in one paint shares the view. */
export function leadWidth(view: View = DEFAULT_VIEW): number {
  return view === "inbound" ? LEAD_WIDTH + 1 : LEAD_WIDTH;
}

const indentFor = (o: RenderOpts) => " ".repeat(leadWidth(o.view));
/** Below this many title columns, the age stamp is dropped. */
const MIN_TITLE = 12;

/** Below this much room the notice is dropped. A bare `…` reads as a
 * truncated pull request, and stderr still names the problem. */
const MIN_NOTICE = 8;

export interface RenderOpts {
  cols: number;
  rows: number;
  now: number;
  /** Null before the first successful fetch. */
  fetchedAt: number | null;
  error?: string | null;
  pollSeconds: number;
  colour: boolean;
  /** Show `owner/repo` instead of `repo`. */
  showOwner: boolean;
  glyphs?: GlyphSet;
  /** PRs matching the search but not fetched (the `first:` cap). */
  omitted?: number;
  view?: View;
  /** One line per PR. `render` sets it when the full layout does not fit. */
  compact?: boolean;
  /** A configuration problem, drawn under the list. A failed refresh goes in
   * `error` instead. */
  notice?: string | null;
}

function paint(text: string, colour: keyof typeof FG, on: boolean): string {
  if (!on || colour === "default") return text;
  return `${FG[colour]}${text}${FG.default}`;
}

function dim(text: string, on: boolean): string {
  return on ? `${DIM}${text}${NORMAL}` : text;
}

/** Visible columns, counted in code points. Double-width CJK counts as one, a
 * known limitation. U+FE0F (emoji presentation) stays in and counts as the
 * second column it costs. U+FE0E (text presentation) is stripped. */
export function width(s: string): number {
  // SGR runs and OSC 8 wrappers occupy no columns.
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

/** OSC 8 hyperlink. The pane claims the mouse, so Herdr does not resolve it:
 * `hitTargets` reads these escapes to build the click map. */
export function link(url: string, text: string, on: boolean): string {
  if (!on || !url) return text;
  return `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
}

/** Rows and columns are 1-based to match mouse reports. */
export interface HitTarget {
  row: number;
  /** First and last visible column, inclusive. */
  from: number;
  to: number;
  url: string;
}

/**
 * The hyperlinked spans of a painted frame. Derive the hit map from the frame,
 * never from a second copy of the layout: a drifted map opens the wrong pull
 * request with no symptom.
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
        const next = line.indexOf(ESC, j);
        const chunk = next === -1 ? line.slice(j) : line.slice(j, next);
        col += width(chunk);
        j += chunk.length;
        continue;
      }
      if (line.startsWith(OPEN, j)) {
        const end = line.indexOf(ST, j);
        // Unterminated OSC 8: an upstream truncation bug, so trust nothing after it.
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

export function hitAt(targets: HitTarget[], row: number, col: number): HitTarget | null {
  return targets.find((t) => t.row === row && col >= t.from && col <= t.to) ?? null;
}

/** The right-hand status cluster, fixed-width so it aligns down the pane. */
function cluster(
  row: PrRow,
  colour: boolean,
  g: Glyphs,
): { plain: string; painted: string } {
  const flag = row.unresolved > 0
    ? `${g.unresolved}${row.unresolvedCapped ? "99+" : String(row.unresolved)}`
    : "";
  // 4 columns holds the mark plus a three-digit count or the 99+ floor.
  const flagCell = flag.padEnd(4, " ");
  const reviewCell = row.review ? g.review[row.review] : " ";
  // Every cell is reserved on every row so the cluster aligns. `none` has no
  // glyph in the set because the sidebar token spends no column on it.
  const ciCell = row.ci === "none" ? " " : g.ci[row.ci];
  const conflictCell = row.conflict ? g.conflict : " ";

  // Each cell needs its own separator: a cell butted against its neighbour
  // reads as one crowded pair.
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

  // Empty cells stay unpainted, so a clean row carries no escapes.
  const painted = `${paint(conflictCell, row.conflict ? "red" : "default", true)} ` +
    `${paint(reviewCell, reviewColour, true)} ` +
    `${flag ? paint(flagCell, "yellow", true) : flagCell}` +
    `${paint(ciCell, ciColour, true)}`;
  return { plain, painted };
}

/** Advances one frame per second to match the pane's repaint. Outside
 * `GLYPHS`: Octicons has no ten-frame animation to swap in. */
export const SPINNER = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"];

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

export function compactAge(ms: number): string {
  return relativeAge(ms).replace(" ago", "");
}

/** "" when GitHub gave no usable timestamp. */
function prAge(row: PrRow, now: number): string {
  const created = Date.parse(row.createdAt);
  return Number.isFinite(created) ? compactAge(now - created) : "";
}

/**
 * Splice the view switcher between `head` and `tail`. It takes columns only
 * from the slack, never from the summary, so a narrow pane drops the switcher.
 * A plain click on it reaches `handleClick`, which matches its URL.
 */
function withSwitcher(head: string, tail: string, colour: keyof typeof FG, o: RenderOpts): string {
  const target = otherView(o.view ?? DEFAULT_VIEW);
  const slack = o.cols - leadWidth(o.view) - width(head) - width(tail);
  // The 3 is the " · " separator.
  const label = SWITCHER_LABELS.find((l) => width(l) + 3 <= slack);
  if (!label) return paint(head + tail, colour, o.colour);
  return paint(head, colour, o.colour) +
    dim(" · ", o.colour) + link(viewUrl(target), dim(label, o.colour), true) +
    paint(tail, colour, o.colour);
}

/**
 * The summary line. An age past twice the poll interval goes yellow, and a
 * failed refresh goes red with its reason, so stale data never passes for fresh.
 */
export function header(rows: PrRow[], o: RenderOpts): string {
  if (o.fetchedAt == null) {
    // Name the view here too, or a cold start looks the same in both views.
    const loading = o.view === "inbound"
      ? `${spinner(o.now)} loading inbound…`
      : `${spinner(o.now)} loading…`;
    const text = o.error ? o.error : loading;
    const body = clip(text, o.cols - leadWidth(o.view));
    return indentFor(o) + withSwitcher(body, "", o.error ? "red" : "default", o);
  }
  const age = o.now - o.fetchedAt;
  const stale = age > o.pollSeconds * 2000;

  // Counting by headline is correct only while `LOUD` is a prefix of
  // `PRECEDENCE`. tests/render.test.ts asserts that.
  const total = rows.length + (o.omitted ?? 0);
  // Every inbound row needs you, so the inbound view drops the count.
  let summary: string;
  if (o.view === "inbound") {
    summary = `${total} inbound`;
  } else {
    const loud = rows.filter((r) => LOUD.includes(headline(r, o.view))).length;
    summary = `${total} open` + (loud > 0 ? ` · ${loud} need you` : "");
  }

  // Clip the whole line, so a narrow pane loses the tail before the count.
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
  // A clipped summary leaves no room, so the switcher is not offered.
  const head = body.startsWith(summary) ? summary : body;
  return indentFor(o) + withSwitcher(head, body.slice(head.length), colour, o);
}

export interface RepoGroup {
  owner: string;
  repo: string;
  rows: PrRow[];
}

/**
 * Collect rows by repository, including rows that are not adjacent. Groups
 * keep first-appearance order and rows keep arrival order, so `+N older`
 * stays correct.
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

/** A dim heading with a rule to the right edge, then the group's loud count. */
export function repoHeader(g: RepoGroup, o: RenderOpts): string {
  const name = `${o.showOwner ? `${g.owner}/` : ""}${g.repo}`;
  const text = clip(name, o.cols);

  // The header's needs-you count, per group, coloured by its loudest signal.
  // The inbound view drops it, as the header does.
  const loud = o.view === "inbound"
    ? []
    : g.rows.filter((r) => LOUD.includes(headline(r, o.view)));
  const badge = loud.length > 0 ? String(loud.length) : "";
  const sig = LOUD.find((x) => loud.some((r) => headline(r, o.view) === x));

  // Reserve the cell when empty, so every rule ends on the same column.
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
 * Line one, exactly `cols` wide. `trailing` candidates sit between the branch
 * and the cluster, longest first. The first that fits in the slack wins, so a
 * narrowing pane sheds the age, then the number, then the branch.
 */
function branchLine(
  row: PrRow,
  o: RenderOpts,
  trailing: Array<{ plain: string; painted: string }> = [],
): string {
  const inbound = o.view === "inbound";
  const sig = headline(row, o.view);
  const g = glyphsFor(o.glyphs);
  const { plain, painted } = cluster(row, o.colour, g);

  const lead = `${row.linked ? g.linked : " "}` +
    `${row.isDraft ? g.draft : " "}` +
    (inbound ? `${row.reason === "involved" ? g.involved : " "}` : "") +
    " ";

  // An inbound row leads with its author and offers the branch as the longest
  // trailing candidate.
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

  // The branch gives up columns before the cluster: a truncated cluster drops
  // a signal. Trailing text uses only the room the whole branch leaves.
  const room = Math.max(0, o.cols - width(lead) - width(plain) - 1);
  const shown = clip(identity, room);
  const fits = candidates.find((t) =>
    t.plain.length > 0 && width(shown) + width(t.plain) <= room
  );

  // No bold on a draft (SGR intensity does not nest) or in the inbound view,
  // where every row is loud.
  let name = paint(shown, SIGNAL_COLOUR[sig], o.colour);
  if (o.colour && !inbound && !row.isDraft && LOUD.includes(sig)) {
    name = `${BOLD}${name}${NORMAL}`;
  }

  const body = fits ? `${name}${fits.painted}` : name;
  const used = width(shown) + (fits ? width(fits.plain) : 0);
  const gap = " ".repeat(Math.max(1, room - used + 1));
  return `${lead}${o.compact ? link(row.url, body, true) : body}${gap}${painted}`;
}

/** Dim a draft's whole row, glyphs included. SGR intensity does not nest, so
 * an inner `NORMAL` ends the row's dim: re-open it after each one. */
function draftDim(lines: string[], row: PrRow, o: RenderOpts): string[] {
  if (!row.isDraft || !o.colour) return lines;
  return lines.map((l) => {
    const body = l.replaceAll(NORMAL, `${NORMAL}${DIM}`);
    const tidy = body.endsWith(DIM) ? body.slice(0, -DIM.length) : body;
    return `${DIM}${tidy}${NORMAL}`;
  });
}

/** The branch line, then the number, title and age. */
export function renderRow(row: PrRow, o: RenderOpts): [string, string] {
  const line1 = branchLine(row, { ...o, compact: false });

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

/** The branch line with the number and age after the branch, and the title's
 * hyperlink moved onto it. */
export function compactRow(row: PrRow, o: RenderOpts): string {
  const num = ` #${row.number}`;
  const age = prAge(row, o.now);
  const both = age ? `${num} ${age}` : num;
  const cell = (t: string) => ({ plain: t, painted: dim(t, o.colour) });
  const line = branchLine(row, { ...o, compact: true },
    both === num ? [cell(num)] : [cell(both), cell(num)]);
  return draftDim([line], row, o)[0]!;
}

/**
 * A configuration problem, drawn under the list in yellow.
 *
 * It leaves one column spare: `⚠` is East-Asian Ambiguous and can render two
 * wide, and a wrap on the pane's last line scrolls the header off the top.
 */
function noticeLine(o: RenderOpts): string | null {
  if (!o.notice) return null;
  const room = o.cols - leadWidth(o.view) - 1;
  if (room < MIN_NOTICE) return null;
  // Two columns go to the glyph and its space.
  const text = clip(o.notice, room - 2);
  if (text.length === 0) return null;
  return indentFor(o) + paint(glyphsFor(o.glyphs).notice, "yellow", o.colour) +
    dim(` ${text}`, o.colour);
}

/**
 * The whole pane. An overflowing list goes compact before it drops rows, then
 * drops the oldest behind a `+N older` marker.
 *
 * Dropping a PR can also drop its heading and the blank line before it, so
 * `cost` measures each candidate instead of dividing by a row height.
 */
export function render(rows: PrRow[], o: RenderOpts): string[] {
  // Authored is oldest-first and inbound newest-first. Both drop the oldest,
  // and the marker sits next to the dropped end.
  const oldestLast = o.view === "inbound";
  const keptRows = (keep: number) =>
    oldestLast ? rows.slice(0, keep) : rows.slice(rows.length - keep);

  const out: string[] = [header(rows, o)];
  if (o.rows > 2) out.push("");

  // Reserve the notice's line before measuring rows, so it costs a pull
  // request instead of being clipped. Every later push must stay within
  // `budget`: the final slice trims the bottom, which is the notice.
  const notice = noticeLine(o);
  const budget = Math.max(0, o.rows - out.length - (notice ? 1 : 0));

  if (rows.length === 0) {
    // Before the first fetch, an empty list means no answer yet.
    if (budget > 0 && o.fetchedAt != null) {
      out.push(
        indentFor(o) + paint(glyphsFor(o.glyphs).clear, "green", o.colour) +
          dim(" all clear", o.colour),
      );
    }
    if (notice) out.push(notice);
    return out.slice(0, o.rows);
  }

  // Marker, blank lines between groups, a heading per group, 1 or 2 lines per PR.
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
  // The walk stops at `keep === 0` without checking that the marker fits, and
  // `cost(0, …)` is 1. Show the marker only when the budget holds it, or it
  // pushes the notice off. The header already counts every PR.
  const marked = dropped > 0 && cost(keep, compact) <= budget;
  const marker = indentFor(o) +
    paint(`${ELLIPSIS} +${dropped} older`, "default", o.colour);
  if (marked && !oldestLast) out.push(marker);

  let first = true;
  for (const g of groupRows(keptRows(keep))) {
    if (!first) out.push("");
    first = false;
    out.push(repoHeader(g, ro));
    for (const row of g.rows) {
      out.push(...(compact ? [compactRow(row, ro)] : renderRow(row, ro)));
    }
  }
  if (marked && oldestLast) out.push(marker);
  if (notice) out.push(notice);
  return out.slice(0, o.rows);
}
