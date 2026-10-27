#!/usr/bin/env bun
// Keeps one widget docked on the right of the focused tab. Herdr has no
// always-on-top surface, so the `tab.focused` and `workspace.focused` hooks run
// this to move the widget. Idempotent: safe to run by hand or on every event.
//
// Herdr can report success it did not deliver, so placement and width are
// measured after every change. The recorded pane id is a hint; the layout
// decides.

import {
  adoptWidget,
  DEFAULT_WIDTH_RATIO,
  dockTarget,
  type Layout,
  paneRatio,
  moveRatio,
  ratioChanged,
  shouldRecordWidth,
  stackPartner,
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
  resyncPane,
  setPaneTitle,
} from "../src/herdr.ts";
import {
  clearPaneId,
  placementInFlight,
  readPaneId,
  readTabWidth,
  readView,
  recordPlacedWidth,
  recordStack,
  recordTabWidth,
  releasePlacementLock,
  takePlacementLock,
  writePaneId,
} from "../src/state.ts";
import { VIEW_TITLE } from "../src/view.ts";

const HERDR = process.env.HERDR_BIN_PATH ?? "herdr";
const ENTRYPOINT = "prs";
/** Backstop for a layout that will not move. */
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
 * Find the widget on screen, keep one, and close any duplicate. Returns null
 * when no widget pane exists, the only case where opening a new one is right.
 */
async function reconcile(tabId: string | undefined, known: string | null): Promise<string | null> {
  const plan = adoptWidget(await listPanes(), WIDGET_LABEL, tabId);
  if (!plan) {
    // The recorded id is a ghost. Clear it so the caller opens a fresh pane.
    if (known) await clearPaneId();
    return null;
  }
  for (const orphan of plan.close) await closePluginPane(orphan);
  if (plan.keep !== known) await writePaneId(plan.keep);
  return plan.keep;
}

/**
 * Walk a placed widget to the remembered width, re-measuring between steps.
 * Three stalls means the layout will not move further.
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
 * Reach the width, then record what was reached. Without that record, a walk
 * that stops short reads as a user drag on the next settled run.
 */
async function settleWidth(paneId: string, tabId: string | undefined, desired: number): Promise<void> {
  recordPlacedWidth(tabId, usableRatio(await applyWidth(paneId, desired)));
}

function widthFor(tabId: string | undefined): number {
  return usableRatio(readTabWidth(tabId).width) ?? DEFAULT_WIDTH_RATIO;
}

/**
 * Record a drag in the tab the widget is about to leave. If you drag the split
 * and then change tab, the next hook fires for the new tab, so this is the last
 * chance to see the drag.
 */
async function recordWidthLeftBehind(paneId: string): Promise<void> {
  const home = await layout(paneId);
  const there = home?.panes.find((p) => p.pane_id === paneId);
  if (!home || !there || home.zoomed) return;
  recordStack(home.tab_id, stackPartner(home.panes, paneId));
  const left = usableRatio(paneRatio(there.rect.width, home.area?.width ?? 0));
  const was = readTabWidth(home.tab_id);
  if (left != null && shouldRecordWidth(left, usableRatio(was.width), usableRatio(was.placed))) {
    recordTabWidth(home.tab_id, left);
  }
}

async function place(l: Layout, recorded: string | null): Promise<number> {
  const desired = widthFor(l.tab_id);

  const known = await reconcile(l.tab_id, recorded);

  // Adopted in this tab, e.g. after a plugin reload. Herdr restored its width,
  // so apply the remembered one.
  if (known && l.panes.some((p) => p.pane_id === known)) {
    await settleWidth(known, l.tab_id, desired);
    return 0;
  }

  const target = dockTarget(l.panes, known);
  if (!target) return 0;

  if (known) {
    await recordWidthLeftBehind(known);

    // The user split the widget's pane top and bottom here last time, so it goes
    // back under that pane. The column width is the partner's: nothing to walk.
    const stack = readTabWidth(l.tab_id).stack;
    if (stack && l.panes.some((p) => p.pane_id === stack.pane)) {
      const moved = await movePane(known, {
        tabId: l.tab_id,
        targetPane: stack.pane,
        split: "down",
        ratio: stack.keep,
      });
      const after = moved ? await layout() : null;
      const placed = after ? await reconcile(after.tab_id, moved) : null;
      if (placed && after?.panes.some((p) => p.pane_id === placed)) {
        await resyncPane(placed);
        return 0;
      }
    }

    // Move, never close-and-reopen: the renderer survives a move, so the list
    // stays on screen.
    const moved = await movePane(known, {
      tabId: l.tab_id,
      targetPane: target.pane_id,
      split: "right",
      ratio: moveRatio(desired),
    });
    // A cross-tab move renames the pane, and the reply carries the new id.
    // Check it against a fresh layout: Herdr reports success for dead panes too.
    if (moved) {
      const after = await layout();
      const placed = after ? await reconcile(after.tab_id, moved) : null;
      if (placed && after?.panes.some((p) => p.pane_id === placed)) {
        await settleWidth(placed, l.tab_id, desired);
        // Herdr sized this tab's ptys before the widget arrived, and the walk
        // above rarely resizes anything, so force the neighbour's pty to resync.
        await resyncPane(placed);
        return 0;
      }
    }
    // The move did not land. Drop the pane so no orphan stays behind.
    await clearPaneId();
    await closePluginPane(known);
  }

  const opened = await openPluginPane(ENTRYPOINT, {
    targetPane: target.pane_id,
    direction: "right",
  });
  if (!opened) return 1;
  await writePaneId(opened);
  await settleWidth(opened, l.tab_id, desired);
  await resyncPane(opened);
  return 0;
}

async function main(): Promise<number> {
  const l = await layout();
  if (!l) return 0;

  const recorded = await readPaneId();
  const settled = recorded ? l.panes.find((p) => p.pane_id === recorded) : undefined;

  // The common case: the widget is already here. It costs no herdr calls beyond
  // the layout read and takes no lock. Only this path records a drag; a width
  // measured after a placement or adoption is not the user's choice.
  if (settled) {
    if (!l.zoomed) {
      const measured = usableRatio(paneRatio(settled.rect.width, l.area?.width ?? 0));
      const here = readTabWidth(l.tab_id);
      const stored = usableRatio(here.width);
      // `placed` is written only when a walk ends, so the lock is what rules
      // out a width measured mid-walk.
      if (
        measured != null &&
        ratioChanged(measured, stored) &&
        !placementInFlight() &&
        shouldRecordWidth(measured, stored, usableRatio(here.placed))
      ) {
        recordTabWidth(l.tab_id, measured);
      }
    }
    return 0;
  }

  // The paired hooks fire together, and two runs would both resize the widget.
  // The loser exits: the winner does the same work.
  if (!(await takePlacementLock())) return 0;
  let code: number;
  try {
    code = await place(l, recorded);
  } finally {
    releasePlacementLock();
  }

  // A new widget has no title, and a moved one has an id its renderer does not
  // know, so apply the title here where the landed id is on hand.
  const placed = await readPaneId();
  if (placed) await setPaneTitle(placed, VIEW_TITLE[await readView()]);
  return code;
}

process.exit(await main());
