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
   * while zoomed says nothing about the user's split. */
  zoomed?: unknown;
}

const rightEdge = (p: LayoutPane) => p.rect.x + p.rect.width;

/**
 * The pane stacked above or below the widget in its column, and the share of
 * the column that pane keeps.
 *
 * Read this before the widget leaves a tab. After it leaves, the partner fills
 * the column and `dockTarget` treats it as an ordinary full-height pane.
 * `pane move` splits only `right` or `down`, so a partner above is preferred:
 * only that order can be restored.
 */
export function stackPartner(
  panes: LayoutPane[],
  widgetId: string,
): { pane: string; keep: number } | null {
  const w = panes.find((p) => p.pane_id === widgetId);
  if (!w) return null;
  const column = panes.filter(
    (p) => p.pane_id !== widgetId && p.rect.x === w.rect.x && p.rect.width === w.rect.width,
  );
  const partner =
    column.find((p) => p.rect.y + p.rect.height === w.rect.y) ??
    column.find((p) => p.rect.y === w.rect.y + w.rect.height);
  if (!partner) return null;
  return { pane: partner.pane_id, keep: partner.rect.height / (partner.rect.height + w.rect.height) };
}

/** A pane shorter than this fraction of the tallest is a strip, not a column. */
const STRIP_FRACTION = 0.8;

/**
 * The rightmost full-height pane in the tab, and among equally-right ones the
 * tallest.
 *
 * Height filters before rightmost decides. The sibling `herdr-motivational-pane`
 * docks a short strip along the bottom right, and splitting that strip turns it
 * into a sliver. A tab of nothing but strips falls back to all of them:
 * docking badly beats not docking.
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
 * One step towards a target width, or null once close enough.
 *
 * `pane resize --amount` is non-linear and layout-dependent: the same amount
 * moves a different number of columns in a different tab, and at the extremes
 * nothing. So the caller steps and re-measures instead of jumping. `stalls`
 * coarsens the step after a resize that moved nothing, because an amount below
 * the layout's resolution is a silent no-op.
 *
 * For a pane on the right, `left` grows it and `right` shrinks it.
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

export function paneRatio(paneWidth: number, areaWidth: number): number {
  if (!Number.isFinite(areaWidth) || areaWidth <= 0) return 0;
  return paneWidth / areaWidth;
}

/** The width when nothing is remembered: about a fifth of the tab. */
export const DEFAULT_WIDTH_RATIO = 0.2;

/**
 * The band a stored or measured ratio must fall in to be believed.
 *
 * Out-of-band values are rejected, never clamped. They come from a zoomed pane
 * or a missing area width, and recording one would wedge the widget at that
 * width in every tab.
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
 * Whether a measured width differs enough from the stored one to remember.
 *
 * The threshold is `WIDTH_TOLERANCE` because the walk cannot reproduce a
 * smaller difference. A stored value inside it would creep a column on every
 * hop.
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
 * Whether a measured width is a user drag worth recording.
 *
 * `placed` is the width the last placement reached. A placement can stop many
 * columns short of the stored width, and a measurement that matches `placed` is
 * that shortfall coming back, not a drag. A drag that lands on `placed` exactly
 * goes unrecorded, which changes nothing on screen.
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
 * The label Herdr gives the widget pane from the manifest's `[[panes]].title`.
 *
 * The pane process needs it too, to find itself in `pane list`: a cross-tab
 * move renames the pane without updating the process's `HERDR_PANE_ID`.
 * `tests/manifest.test.ts` keeps this in step with the manifest.
 */
export const WIDGET_LABEL = "prs";

export interface WidgetPane {
  pane_id: string;
  label?: string;
  agent?: string;
  tab_id?: string;
}

/**
 * Which pane to treat as the widget when the recorded id is stale, and which
 * duplicates to close.
 *
 * Disabling and re-enabling the plugin reopens the widget under a new id
 * without running `follow`. `pane move` then reports success for the dead id,
 * so the recorded id cannot be trusted.
 *
 * Match on `label`, never `cwd`: a plugin pane's cwd is the plugin root, the
 * same as a user's shell opened in this repo. A widget in the focused tab wins.
 * Every other pane with the label is an orphan.
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
 * Whether another run's placement lock may be taken over.
 *
 * The lock is a lease, so a run killed mid-placement cannot block placement
 * for the rest of the session. The TTL is far longer than a placement, because
 * stealing a live lock brings back the concurrent resizing the lock prevents.
 */
export function lockIsStale(heldSinceMs: number, nowMs: number, ttlMs = 15_000): boolean {
  if (!Number.isFinite(heldSinceMs)) return true;
  // A lock stamped in the future is a clock change, not a live run.
  return nowMs - heldSinceMs >= ttlMs || heldSinceMs > nowMs;
}

/**
 * The `--ratio` to hand `pane move`.
 *
 * `--ratio` is the share the target pane keeps, so pass the complement of the
 * widget's width. The widget then arrives at its final width and needs no
 * visible walk.
 */
export function moveRatio(desiredRatio: number): number {
  if (!Number.isFinite(desiredRatio)) return 1 - DEFAULT_WIDTH_RATIO;
  const complement = 1 - Math.min(Math.max(desiredRatio, 0.01), 0.99);
  return Math.round(complement * 1000) / 1000;
}
