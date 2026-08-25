#!/usr/bin/env bun
// Keeps exactly one widget, docked on the right of whatever tab you are in.
//
// Herdr has no always-on-top surface: plugin panes live inside a tab's tiled
// layout. So the widget follows you instead — `tab.focused` and
// `workspace.focused` hooks land here and relocate it.
//
// Idempotent by design: it converges on "one widget, in the focused tab, on the
// right", so it is safe to run by hand and safe to fire on every event.
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
// And placement is serialised: Herdr fires the two hooks above together, so two
// runs would otherwise resize the same widget twice.

import {
  adoptWidget,
  DEFAULT_WIDTH_RATIO,
  dockTarget,
  type Layout,
  paneRatio,
  moveRatio,
  ratioChanged,
  shouldRecordWidth,
  usableRatio,
  WIDGET_LABEL,
  widthStep,
} from "../src/dock.ts";
import {
  closePluginPane,
  listPanes,
  movePane,
  openPluginPane,
  resizePane,
  setPaneTitle,
} from "../src/herdr.ts";
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
} from "../src/state.ts";
import { VIEW_TITLE } from "../src/view.ts";

const HERDR = process.env.HERDR_BIN_PATH ?? "herdr";
const ENTRYPOINT = "prs";
/** Cap on resize steps. The approach halves its step as it closes, so this is a
 * backstop against a layout that will not move, not a normal exit. */
const MAX_WIDTH_STEPS = 12;

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
 * Find the widget as it actually is, keep one, and close any duplicate.
 *
 * Returns the id to work with, or null when no widget pane exists anywhere —
 * which is the one case where opening a new one is right. Reconciling here is
 * what stops a stale id being acted on: a `pane move` aimed at a closed plugin
 * pane succeeds *and* respawns the pane under a new id, so believing the move
 * left the old id recorded and the same bogus move ran on every hook.
 */
async function reconcile(tabId: string | undefined, known: string | null): Promise<string | null> {
  const plan = adoptWidget(await listPanes(), WIDGET_LABEL, tabId);
  if (!plan) {
    // Nothing is on screen, so whatever was recorded is a ghost. Clearing it
    // means the open below is a plain open rather than a move of a dead pane.
    if (known) await clearPaneId();
    return null;
  }
  for (const orphan of plan.close) await closePluginPane(orphan);
  if (plan.keep !== known) await writePaneId(plan.keep);
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
 * A drag is normally noticed by a later hook firing while the widget is settled,
 * but the ordinary sequence defeats that: you drag the split and then change
 * space, and the next hook fires for the tab you arrived in, never for the one
 * you left. So the width is read off the widget where it still stands, before
 * moving it, which is the last moment the user's choice is observable.
 */
async function widthLeftBehind(paneId: string): Promise<number | null> {
  const home = await layout(paneId);
  const there = home?.panes.find((p) => p.pane_id === paneId);
  if (!home || !there || home.zoomed) return null;
  return usableRatio(paneRatio(there.rect.width, home.area?.width ?? 0));
}

async function place(l: Layout, stored: number | null, recorded: string | null): Promise<number> {
  let desired = stored ?? DEFAULT_WIDTH_RATIO;

  // The recorded id is absent from this tab: either the widget is in another
  // tab, or the id is stale. Both are answered by looking at what exists.
  const known = await reconcile(l.tab_id, recorded);

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
      const after = await layout();
      const placed = after ? await reconcile(after.tab_id, moved) : null;
      if (placed && after?.panes.some((p) => p.pane_id === placed)) {
        // Corrective only. With the complement ratio the widget arrives at its
        // final width and this finds nothing to do; it earns its keep when the
        // target was too narrow to give up the columns.
        await settleWidth(placed, desired);
        return 0;
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

async function main(): Promise<number> {
  const l = await layout();
  if (!l) return 0;

  // The width the user last left the widget at, if any. A stored value outside
  // the believable band is treated as absent rather than clamped, so a bad
  // record costs one dock at the default instead of persisting forever.
  const stored = usableRatio(await readWidthRatio());
  const desired = stored ?? DEFAULT_WIDTH_RATIO;

  const recorded = await readPaneId();
  const settled = recorded ? l.panes.find((p) => p.pane_id === recorded) : undefined;

  // The recorded widget is already in this tab: nothing to place. This is the
  // common case — these hooks fire constantly, in pairs — so it must cost no
  // herdr calls beyond the layout read above, and it must not take the lock.
  //
  // It is also the only moment the widget's *actual* width is on hand, so this
  // is where a manual resize gets noticed: the user drags the split, and the
  // next tab change reads it back off the layout we already fetched and records
  // it. Only this path records. A width measured on a pane we just placed is
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

  // Placing means moving and resizing, and the paired hooks arrive together. A
  // second run would resize the same widget a second time, landing it at a width
  // neither run intended. The loser exits: the winner is doing identical work.
  if (!(await takePlacementLock())) return 0;
  let code: number;
  try {
    code = await place(l, stored, recorded);
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

process.exit(await main());
