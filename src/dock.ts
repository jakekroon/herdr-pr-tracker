// Where the widget docks. Pure, so it is testable without running follow.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutPane {
  pane_id: string;
  focused?: boolean;
  rect: Rect;
}

export interface Layout {
  tab_id?: string;
  focused_pane_id?: string;
  panes: LayoutPane[];
  area?: Rect;
  /** A zoomed tab reports the zoomed pane at full width, so a width measured
   * while zoomed says nothing about the split the user chose. */
  zoomed?: unknown;
}

const rightEdge = (p: LayoutPane) => p.rect.x + p.rect.width;

/**
 * How short a pane may be, against the tallest in the tab, and still be worth
 * splitting. A pane below this is a strip along an edge, not a column.
 */
const STRIP_FRACTION = 0.8;

/**
 * The pane to split off: the rightmost full-height pane in the tab, and among
 * equally-right ones the tallest.
 *
 * Splitting the rightmost pane is what puts the widget in the right-hand
 * column. **Short panes are excluded before rightmost is considered**, and that
 * ordering is the whole point — it was originally only a tiebreak between panes
 * with the *same* right edge, which left the ordinary case broken: the sibling
 * `herdr-motivational-pane` docks a seven-row strip along the bottom of the
 * right-hand column, so once the widget itself is excluded that strip is the
 * rightmost thing in the tab outright, with no tie to break. Splitting it
 * turned it into a five-column full-height sliver and put the widget beside it
 * — probed 2026-08-25, on every placement, in both directions depending on
 * which plugin's `follow` ran last.
 *
 * So "tall enough to be a column" is a filter, and rightmost decides only among
 * those. A tab with nothing but strips falls back to all of them rather than
 * returning null: docking badly beats not docking at all.
 */
export function dockTarget(
  panes: LayoutPane[],
  exclude: string | null,
): LayoutPane | null {
  const candidates = panes.filter((p) => p.pane_id !== exclude && p.rect);
  if (candidates.length === 0) return null;
  const tallest = candidates.reduce((h, p) => Math.max(h, p.rect.height), 0);
  const columns = candidates.filter((p) => p.rect.height >= tallest * STRIP_FRACTION);
  return (columns.length > 0 ? columns : candidates).reduce((best, p) => {
    if (rightEdge(p) !== rightEdge(best)) {
      return rightEdge(p) > rightEdge(best) ? p : best;
    }
    return p.rect.height > best.rect.height ? p : best;
  });
}

/**
 * One step of the approach to a target width, or null once close enough.
 *
 * `pane resize --amount` is a **ratio delta**, and — probed here and
 * independently in the sibling `herdr-motivational-pane` — it is **non-linear
 * and layout-dependent**: the same amount moves a different number of columns
 * in a different tab, and at the extremes moves nothing at all. So a single
 * computed jump to the target cannot be trusted, which is how the widget ended
 * up at a tenth of the tab after a workspace change instead of the fifth it had
 * been left at.
 *
 * The caller therefore steps and re-measures. Steps are coarse while far away
 * and fine near the target, so the last approach cannot overshoot; `stalls`
 * coarsens the step when a resize moved nothing, because an amount under a
 * layout's resolution is a no-op rather than an error.
 *
 * Direction is from the widget's point of view and reads backwards: for a pane
 * on the right, `left` moves the shared edge leftward and so **grows** it,
 * while `right` shrinks it.
 */
export const WIDTH_TOLERANCE = 0.02;

const STEPS = [0.1, 0.05, 0.02];

export function widthStep(
  currentRatio: number,
  desiredRatio: number,
  stalls = 0,
): { direction: "left" | "right"; amount: number } | null {
  const delta = desiredRatio - currentRatio;
  if (!Number.isFinite(delta) || Math.abs(delta) < WIDTH_TOLERANCE) return null;
  const gap = Math.abs(delta);
  const rung = gap >= 0.15 ? 0 : gap >= 0.06 ? 1 : 2;
  const amount = STEPS[Math.max(0, rung - stalls)] ?? STEPS[0];
  return { direction: delta > 0 ? "left" : "right", amount: amount as number };
}

/** A pane's share of the area that contains it. */
export function paneRatio(paneWidth: number, areaWidth: number): number {
  if (!Number.isFinite(areaWidth) || areaWidth <= 0) return 0;
  return paneWidth / areaWidth;
}

/**
 * The width the widget docks at when nothing has been remembered: about a fifth
 * of the tab.
 */
export const DEFAULT_WIDTH_RATIO = 0.2;

/**
 * The band a width ratio has to fall in to be believed.
 *
 * Both a *stored* and a *measured* ratio go through this. Rejecting rather than
 * clamping is the point: a measurement outside the band did not come from a
 * user dragging a split, it came from a layout the widget was not really in
 * (a zoomed pane, an area width Herdr did not report), and recording it would
 * wedge the widget at that width in every tab from then on.
 */
const MIN_RATIO = 0.08;
const MAX_RATIO = 0.6;

/** A width ratio rounded to what `--ratio` can express, or null if unusable. */
export function usableRatio(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < MIN_RATIO || value > MAX_RATIO) return null;
  return Math.round(value * 1000) / 1000;
}

/**
 * Whether a freshly measured width is a manual resize worth remembering.
 *
 * The threshold is `WIDTH_TOLERANCE`, the same band the approach stops inside —
 * because **a width that cannot be reproduced is not worth remembering**. The
 * finest usable resize step moves several columns, so recording a
 * two-column difference would store a number the next dock could not land on,
 * and the stored value would then creep by a column on every hop. It also keeps
 * the widget's own arithmetic out of the record: a dock that stops legitimately
 * short of the target must not be read back as the user having chosen that
 * width.
 */
export function ratioChanged(
  measured: number | null,
  stored: number | null,
  epsilon = WIDTH_TOLERANCE,
): boolean {
  if (measured == null) return false;
  if (stored == null) return true;
  return Math.abs(measured - stored) >= epsilon;
}

/**
 * Whether a freshly measured width should be written back as the preference.
 *
 * `ratioChanged` alone was not enough, and the gap was the case its own comment
 * claims to cover: "a dock that stops legitimately short of the target must not
 * be read back as the user having chosen that width". The epsilon is about one
 * column, so it only ever caught a shortfall of *one column* — a placement that
 * lands eleven columns short sails straight past it and gets recorded. Measured
 * 2026-08-25: a stored 0.311 that the walk could only reach 0.258 of was
 * rewritten to 0.258 by the very next settled run, and each hop would take
 * another bite.
 *
 * So the width a placement actually *achieved* is remembered too, and a
 * measurement that matches it is treated as the widget's own arithmetic coming
 * back rather than a choice. A drag moves the split away from both numbers,
 * which is what makes the two distinguishable at all.
 *
 * A drag that happens to land exactly on the achieved width is not recorded —
 * it is indistinguishable from no drag at all, and it is the width the pane is
 * already wearing, so nothing on screen changes either way.
 */
export function shouldRecordWidth(
  measured: number | null,
  stored: number | null,
  placed: number | null,
  epsilon = WIDTH_TOLERANCE,
): boolean {
  if (measured == null) return false;
  if (!ratioChanged(measured, stored, epsilon)) return false;
  if (placed != null && Math.abs(measured - placed) < epsilon) return false;
  return true;
}

/**
 * The label Herdr gives the widget pane, taken from the manifest's
 * `[[panes]].title`, and the discriminator `adoptWidget` matches on.
 *
 * It lives here rather than in `bin/follow.ts` because the pane process needs
 * it too: the widget has to find *itself* in `pane list` to set its title, and
 * `HERDR_PANE_ID` cannot answer that — it is the id the process was launched
 * with, and a cross-tab move renames the pane without telling the process
 * (probed: a live widget's env said `w23:p1` while the pane was `w23:pX`).
 * `tests/manifest.test.ts` holds this and the manifest title in step.
 */
export const WIDGET_LABEL = "prs";

/** What `adoptWidget` needs off a `pane list` entry. */
export interface WidgetPane {
  pane_id: string;
  label?: string;
  agent?: string;
  tab_id?: string;
}

/**
 * Which pane to treat as the widget when the recorded id is no good, and which
 * to close.
 *
 * The recorded id goes stale without anything telling the plugin: disabling and
 * re-enabling the plugin closes the widget pane and Herdr reopens it under a
 * **new id**, never running `follow`. Trusting the old id then costs more than a
 * blank pane, because `pane move` *reports success* for a plugin pane id that no
 * longer exists — so `follow` believed it had relocated the widget, exited, and
 * left the stale id in place to be moved again on the next hook. Adopting the
 * pane that is actually there is what breaks that loop.
 *
 * The discriminator is `label`, which Herdr sets from the manifest's
 * `[[panes]].title` and reports on `pane list`. It is used rather than `cwd`
 * because a plugin pane's cwd is the plugin root — indistinguishable from an
 * ordinary shell opened in this repo, which adoption must never seize and start
 * relocating. `agent` excludes an agent pane that happens to carry a label.
 *
 * A widget in the focused tab wins, so a pane already in front of the user is
 * kept rather than closed in favour of one in a tab they cannot see. Everything
 * else with the same label is an orphan from a failed placement, and closing it
 * restores the single-widget invariant.
 */
export function adoptWidget(
  panes: WidgetPane[],
  label: string,
  tabId?: string,
): { keep: string; close: string[] } | null {
  const mine = panes.filter((p) => p.label === label && !p.agent);
  if (mine.length === 0) return null;
  const keep = (tabId == null ? undefined : mine.find((p) => p.tab_id === tabId)) ?? mine[0];
  if (!keep) return null;
  return {
    keep: keep.pane_id,
    close: mine.filter((p) => p.pane_id !== keep.pane_id).map((p) => p.pane_id),
  };
}

/**
 * Whether a placement lock left behind by another run may be taken over.
 *
 * A lock file outlives a run that was killed — a pane closed mid-resize, a
 * machine asleep — and a lock nobody will ever release would stop the widget
 * being placed for the rest of the session. So it is a lease, not a mutex.
 * The TTL is far longer than a placement takes, because stealing a live lock
 * reintroduces exactly the concurrent resizing it exists to prevent.
 */
export function lockIsStale(heldSinceMs: number, nowMs: number, ttlMs = 15_000): boolean {
  if (!Number.isFinite(heldSinceMs)) return true;
  // A lock stamped in the future is a clock change, not a live run.
  return nowMs - heldSinceMs >= ttlMs || heldSinceMs > nowMs;
}

/**
 * The `--ratio` to hand `pane move`.
 *
 * **`--ratio` is the share the *target* pane keeps, not the share the moved pane
 * gets.** Probed: moving the widget onto a 209-column tab with `--ratio 0.8`
 * landed the widget at 0.201. The sibling `herdr-motivational-pane` states the
 * same rule for its `--split down` ("a split leaves the ORIGINAL pane holding
 * the ratio, so hand the target the complement").
 *
 * Passing the desired width directly is what made a space change visibly move
 * the widget: it arrived at *four fifths* of the tab and then had to be walked
 * all the way down a step at a time, in full view. With the complement it
 * arrives at its final width and the corrective walk finds nothing to do.
 */
export function moveRatio(desiredRatio: number): number {
  if (!Number.isFinite(desiredRatio)) return 1 - DEFAULT_WIDTH_RATIO;
  const complement = 1 - Math.min(Math.max(desiredRatio, 0.01), 0.99);
  return Math.round(complement * 1000) / 1000;
}
