// Where the widget belongs, and how it gets there.
//
// Herdr has no always-on-top surface: plugin panes live inside a tab's tiled
// layout. So the widget follows you instead — this converges on "one widget, in
// the tab you are looking at, on the right", and is safe to run at any time,
// from any number of processes at once.
//
// Two callers, and the difference between them is the one argument this module
// takes:
//
//   - `bin/follow.ts`, run as a `tab.focused`/`workspace.focused` hook, wants
//     `"current"`: the tab its event fired for, which Herdr hands it through
//     `HERDR_PANE_ID`.
//   - `src/watch.ts`, polling from inside the long-lived pane process, wants
//     `"focused"`: the tab the user is in *now*. `--current` would resolve from
//     the widget's own launch id, which a cross-tab move has already made stale.
//
// Two things are measured rather than assumed, both because Herdr reports
// success it does not deliver:
//
//   - Placement. `pane move` returns success for a plugin pane that no longer
//     exists, and can respawn the widget under a new id. So the recorded id is
//     a hint; the layout decides.
//   - Width. `pane resize --amount` is non-linear and layout-dependent, so the
//     width is approached in steps that re-measure, never one computed jump.
//
// And placement is serialised: the hooks fire in pairs and the watcher polls
// underneath them, so several runs can want to place the widget at once. The
// run holding the lock then keeps re-reading the focused tab until the widget
// is in it, because a burst of switches queues runs whose targets differ and
// only the winner's survives.

import {
  adoptWidget,
  DEFAULT_WIDTH_RATIO,
  dockTarget,
  type Layout,
  paneRatio,
  moveRatio,
  placementOwed,
  ratioChanged,
  shouldRecordWidth,
  usableRatio,
  WIDGET_LABEL,
  widthStep,
} from "./dock.ts";
import {
  closePluginPane,
  listPanes,
  movePane,
  openPluginPane,
  resizePane,
  setPaneTitle,
} from "./herdr.ts";
import {
  clearPaneId,
  clearPlacedRatio,
  placementInFlight,
  readPaneId,
  readPlacedRatio,
  readView,
  readWidthRatio,
  releasePlacementLock,
  takePlacementLock,
  writePaneId,
  writePlacedRatio,
  writeWidthRatio,
} from "./state.ts";
import { VIEW_TITLE } from "./view.ts";

/**
 * Which tab a run is trying to put the widget in.
 *
 * `"current"` is the tab the calling process belongs to — for a hook, the tab
 * its event was about. `"focused"` is wherever the user is now, read from live
 * focus rather than from the caller's own identity.
 */
export type FocusSource = "current" | "focused";

const HERDR = process.env.HERDR_BIN_PATH ?? "herdr";
/**
 * The manifest pane entrypoint the widget is opened from.
 *
 * Exported so `tests/manifest.test.ts` can compare it against the manifest by
 * importing it, rather than by grepping this file for its own source.
 */
export const ENTRYPOINT = "prs";
/** Cap on resize steps. The approach halves its step as it closes, so this is a
 * backstop against a layout that will not move, not a normal exit. */
const MAX_WIDTH_STEPS = 12;
/** Cap on placement passes in one run. `placementOwed` ends the loop; this is
 * the backstop against a tab id that keeps changing under it. */
const MAX_PLACEMENT_PASSES = 4;

async function layout(paneId?: string): Promise<Layout | null> {
  try {
    const p = Bun.spawn(
      [HERDR, "pane", "layout", ...(paneId ? ["--pane", paneId] : ["--current"])],
      { stdout: "pipe", stderr: "ignore" },
    );
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (code !== 0) return null;
    const l = JSON.parse(out)?.result?.layout;
    if (!l || !Array.isArray(l.panes)) return null;
    return l as Layout;
  } catch {
    return null;
  }
}

/**
 * The layout of the tab focused *now*, rather than the tab this run fired for.
 *
 * Deliberately not `pane layout --current`. Probed 2026-09-16: `--current`
 * resolves from the calling process's own `HERDR_PANE_ID`, so a hook is handed
 * the tab its event was about and is handed the same tab however often it asks
 * — focusing five other workspaces in between leaves the answer unchanged. A
 * convergence loop built on `--current` re-reads the tab it started with and
 * concludes it has nothing left to do, which is what the first attempt at this
 * fix did: four green unit tests, six bursts, no change on screen. Exactly one
 * pane in `pane list` carries `focused`, and that one moves with the user.
 */
async function focusedLayout(): Promise<Layout | null> {
  const focused = (await listPanes()).find((p) => p.focused);
  return focused ? await layout(focused.pane_id) : null;
}

/**
 * Find the widget as it actually is, keep one, and close any duplicate.
 *
 * Returns the id to work with, or null when no widget pane exists anywhere —
 * which is the one case where opening a new one is right. Reconciling here is
 * what stops a stale id being acted on: a `pane move` aimed at a closed plugin
 * pane succeeds *and* respawns the pane under a new id, so believing the move
 * left the old id recorded and the same bogus move ran on every hook.
 *
 * The write is unconditional, and that is the fix for a second bug. It used to
 * be skipped when the kept id matched the one the caller passed in — but the
 * post-move caller passes the id the move just handed back, which is by
 * construction the id adoption finds, so the write never ran and the file kept
 * the *pre-move* id. Measured 2026-09-16 across six placements: the recorded id
 * was one placement behind on every one. `main`'s settled fast path matches on
 * that id, so it never matched, every focus event took the lock and walked a
 * full move-and-resize, and the width-drag recording that only the settled path
 * performs never ran at all.
 */
async function reconcile(tabId: string | undefined): Promise<string | null> {
  const plan = adoptWidget(await listPanes(), WIDGET_LABEL, tabId);
  if (!plan) {
    // Nothing is on screen, so whatever was recorded is a ghost. Clearing it
    // means the open below is a plain open rather than a move of a dead pane.
    await clearPaneId();
    return null;
  }
  for (const orphan of plan.close) await closePluginPane(orphan);
  await writePaneId(plan.keep);
  return plan.keep;
}

/**
 * Walk a freshly placed widget to the width the user last left it at.
 *
 * Steps and re-measures rather than computing one jump, because `--amount` is a
 * non-linear, layout-dependent delta. A step that moves nothing means the amount
 * is below this layout's resolution, so the step coarsens; three stalls means
 * the layout will not move any further and the width we have is the width there
 * is.
 */
async function applyWidth(paneId: string, desired: number): Promise<number | null> {
  let stalls = 0;
  let reached: number | null = null;
  for (let i = 0; i < MAX_WIDTH_STEPS; i++) {
    const l = await layout(paneId);
    const widget = l?.panes.find((p) => p.pane_id === paneId);
    if (!l || !widget) return reached;
    reached = paneRatio(widget.rect.width, l.area?.width ?? 0);
    const step = widthStep(reached, desired, stalls);
    if (!step) return reached;
    const before = widget.rect.width;
    await resizePane(paneId, step.direction, step.amount);
    const after = await layout(paneId);
    const moved = after?.panes.find((p) => p.pane_id === paneId);
    if (!moved) return reached;
    reached = paneRatio(moved.rect.width, after?.area?.width ?? 0);
    if (moved.rect.width === before) {
      stalls += 1;
      if (stalls >= 3) return reached;
    } else {
      stalls = 0;
    }
  }
  return reached;
}

/**
 * Reach the width, then record what was actually reached.
 *
 * Every placement goes through here rather than calling `applyWidth` directly,
 * because a walk that stops short leaves the pane wearing a width nobody chose —
 * and the settled path, which is the one that records a drag, cannot otherwise
 * tell that width from a drag. Writing down what the arithmetic achieved is what
 * makes the two distinguishable.
 */
async function settleWidth(paneId: string, desired: number): Promise<void> {
  const reached = usableRatio(await applyWidth(paneId, desired));
  if (reached != null) await writePlacedRatio(reached);
  else await clearPlacedRatio();
}

/**
 * The width the widget is wearing in the tab it is about to leave.
 *
 * A drag is normally noticed by the settled path running while the widget is
 * still in the tab, which the poll in `src/watch.ts` now guarantees within a
 * reconcile. It did not always: back when the only caller was a focus hook, the
 * ordinary sequence defeated it — you drag the split and then change space, and
 * the next hook fires for the tab you arrived in, never for the one you left.
 * So the width is also read off the widget where it still stands, before moving
 * it, which is the last moment the user's choice is observable either way.
 */
async function widthLeftBehind(paneId: string): Promise<number | null> {
  const home = await layout(paneId);
  const there = home?.panes.find((p) => p.pane_id === paneId);
  if (!home || !there || home.zoomed) return null;
  return usableRatio(paneRatio(there.rect.width, home.area?.width ?? 0));
}

async function place(l: Layout, stored: number | null): Promise<number> {
  let desired = stored ?? DEFAULT_WIDTH_RATIO;

  // The recorded id is absent from this tab: either the widget is in another
  // tab, or the id is stale. Both are answered by looking at what exists.
  const known = await reconcile(l.tab_id);

  // Adoption found it already here — Herdr reopened it after a plugin reload, or
  // a previous run placed it without recording. It keeps its place; the
  // remembered width is restored, since the width it came back at is not one the
  // user chose.
  if (known && l.panes.some((p) => p.pane_id === known)) {
    await settleWidth(known, desired);
    return 0;
  }

  const target = dockTarget(l.panes, known);
  if (!target) return 0;

  if (known) {
    // Carry the width across rather than re-imposing the stored one: the widget
    // is still standing in its old tab, so this is the one chance to see a drag
    // that no settled run ever got to observe.
    // Same hazard as the settled path: the width standing in the old tab is a
    // drag only if it is not the width the last placement managed to reach.
    const left = await widthLeftBehind(known);
    if (left != null && shouldRecordWidth(left, stored, usableRatio(await readPlacedRatio()))) {
      await writeWidthRatio(left);
      await clearPlacedRatio();
      desired = left;
    }

    // Relocate rather than close-and-reopen: the renderer process survives the
    // trip, so the list stays on screen instead of blanking and refetching.
    //
    // The ratio is the *complement* of the width wanted, because `--ratio` is
    // the share the target pane keeps. Getting this backwards is what made a
    // space change visibly move the widget: it arrived at four fifths of the tab
    // and was then walked down to a fifth in full view.
    const moved = await movePane(known, {
      tabId: l.tab_id,
      targetPane: target.pane_id,
      split: "right",
      ratio: moveRatio(desired),
    });
    // A cross-tab move renames the pane, so the id to record is the one the
    // reply hands back. Herdr also reports success for a move of a pane that no
    // longer exists, so the id is still checked against a fresh layout rather
    // than believed: a widget in this tab afterwards means the move landed.
    if (moved) {
      // Read the moved pane's own tab, not `--current`: `--current` is pinned to
      // the tab this run fired for (see `focusedLayout`), so a later pass aiming
      // at a different tab would measure its move against the first tab, find
      // the widget absent, and treat a landed move as a failure — then close and
      // reopen the widget, restarting the renderer for nothing.
      const after = await layout(moved);
      if (after && after.tab_id === l.tab_id) {
        const placed = await reconcile(after.tab_id);
        if (placed && after.panes.some((p) => p.pane_id === placed)) {
          // Corrective only. With the complement ratio the widget arrives at its
          // final width and this finds nothing to do; it earns its keep when the
          // target was too narrow to give up the columns.
          await settleWidth(placed, desired);
          return 0;
        }
      }
    }
    // It did not land and nothing was adopted, so the recorded pane is beyond
    // reach. Drop it rather than orphaning a second widget behind it.
    await clearPaneId();
    await closePluginPane(known);
  }

  const opened = await openPluginPane(ENTRYPOINT, {
    targetPane: target.pane_id,
    direction: "right",
  });
  if (!opened) return 1;
  await writePaneId(opened);
  await settleWidth(opened, desired);
  return 0;
}

export async function followFocus(from: FocusSource = "current"): Promise<number> {
  const l = from === "focused" ? await focusedLayout() : await layout();
  if (!l) return 0;

  // The width the user last left the widget at, if any. A stored value outside
  // the believable band is treated as absent rather than clamped, so a bad
  // record costs one dock at the default instead of persisting forever.
  const stored = usableRatio(await readWidthRatio());
  const desired = stored ?? DEFAULT_WIDTH_RATIO;

  const recorded = await readPaneId();
  const settled = recorded ? l.panes.find((p) => p.pane_id === recorded) : undefined;

  // The recorded widget is already in this tab: nothing to place. This is the
  // overwhelmingly common case — the watcher reconciles every few seconds and
  // the hooks fire in pairs on top of that — so it must cost no herdr calls
  // beyond the layout read above, and it must not take the lock.
  //
  // It is also the only moment the widget's *actual* width is on hand, so this
  // is where a manual resize gets noticed: the user drags the split, and the
  // next run reads it back off the layout we already fetched and records it. Only this path records. A width measured on a pane we just placed is
  // our own arithmetic coming back, and a width measured on an adopted pane is
  // whatever Herdr restored it at — recording either would overwrite the user's
  // choice with a number they never chose. Skipped while zoomed, where the
  // reported width is not the split.
  if (settled) {
    if (!l.zoomed) {
      const measured = usableRatio(paneRatio(settled.rect.width, l.area?.width ?? 0));
      // Two cheap guards before any file read, because the overwhelmingly
      // common case is a width that has not moved at all:
      //
      //   - nothing changed, so there is nothing to record;
      //   - a placement is still walking this pane, so the width on screen is
      //     mid-arithmetic. `placed_ratio` cannot rule that out — it is not
      //     written until the walk ends — so the lock is what answers it.
      if (measured != null && ratioChanged(measured, stored) && !placementInFlight()) {
        const placed = usableRatio(await readPlacedRatio());
        if (shouldRecordWidth(measured, stored, placed)) {
          await writeWidthRatio(measured);
          // The user has now chosen a width, so the last placement's shortfall
          // is no longer the explanation for anything.
          await clearPlacedRatio();
        }
      }
    }
    return 0;
  }

  // Placing means moving and resizing, and runs collide: the paired hooks arrive
  // together, and the watcher polls underneath them from another process. A
  // second run would resize the same widget a second time, landing it at a width
  // neither run intended. So the loser exits rather than waiting, and the winner
  // has to converge instead of firing once. The paired hooks carry the same tab,
  // so there the loser is redundant — but a burst of workspace switches queues
  // runs whose targets differ, and discarding a loser discards the tab you ended
  // up in. The winner re-reads the focused tab after each placement, under the
  // same lock, and places again while `placementOwed` says focus has moved on.
  if (!(await takePlacementLock())) return 0;
  let code = 0;
  try {
    let target = l;
    for (let pass = 0; pass < MAX_PLACEMENT_PASSES; pass++) {
      code = await place(target, stored);
      const focused = await focusedLayout();
      if (!focused || !placementOwed(target.tab_id, focused.tab_id)) break;
      target = focused;
    }
  } finally {
    releasePlacementLock();
  }

  // The title names the view the pane is showing, and the pane process sets it
  // when the view changes — but it cannot set it for a pane it has not been
  // told about. A freshly opened widget has no title yet, and a moved one wears
  // an id the renderer's `HERDR_PANE_ID` no longer names, so the title is
  // re-applied here, where the id that actually landed is on hand. Only on the
  // placing path: the settled early exit above deliberately costs no herdr
  // calls.
  const placed = await readPaneId();
  if (placed) await setPaneTitle(placed, VIEW_TITLE[await readView()]);
  return code;
}
