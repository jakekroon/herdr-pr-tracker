// The renderer is long-lived, so it holds the PR list in memory. This module
// exists for the case that is easy to get wrong: a restart. Without a cached
// last-good result, toggling the widget shows an empty pane for a whole poll
// interval, which is indistinguishable from "you have no open PRs".

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockIsStale } from "./dock.ts";
import type { PrRow } from "./model.ts";

export interface Snapshot {
  fetchedAt: number;
  rows: PrRow[];
  omitted: number;
}

export function stateDir(): string {
  return (
    process.env.HERDR_PLUGIN_STATE_DIR ??
    join(
      process.env.HOME ?? ".",
      ".local/state/herdr/plugins",
      process.env.HERDR_PLUGIN_ID ?? "herdr-pr-tracker",
    )
  );
}

const snapshotPath = () => join(stateDir(), "last.json");

export async function readSnapshot(): Promise<Snapshot | null> {
  try {
    const raw = await Bun.file(snapshotPath()).json();
    if (typeof raw?.fetchedAt !== "number" || !Array.isArray(raw?.rows)) return null;
    return { fetchedAt: raw.fetchedAt, rows: raw.rows, omitted: raw.omitted ?? 0 };
  } catch {
    // A missing, truncated or half-written file is a cold start, not an error.
    return null;
  }
}

export async function writeSnapshot(s: Snapshot): Promise<void> {
  const path = snapshotPath();
  try {
    // Write-then-rename so a renderer killed mid-write cannot leave a
    // truncated file that reads as "no open PRs" on the next start.
    const tmp = `${path}.tmp`;
    await Bun.write(tmp, JSON.stringify(s));
    await Bun.write(path, Bun.file(tmp));
    await Bun.file(tmp).delete().catch(() => {});
  } catch {
    // Caching is a convenience; failing to cache must never break the pane.
  }
}

/** The single-widget invariant: one pane id, recorded so `follow` moves the
 * existing pane instead of opening a second one nothing can then close. */
export async function readPaneId(): Promise<string | null> {
  try {
    const t = (await Bun.file(join(stateDir(), "pane_id")).text()).trim();
    return t || null;
  } catch {
    return null;
  }
}

export async function writePaneId(id: string): Promise<void> {
  await Bun.write(join(stateDir(), "pane_id"), `${id}\n`);
}

export async function clearPaneId(): Promise<void> {
  await Bun.file(join(stateDir(), "pane_id")).delete().catch(() => {});
}

/**
 * The remembered width, as a fraction of the tab.
 *
 * The widget is relocated into whichever tab you enter, and a relocation has to
 * name a width — so without this, every tab change reset the width the user had
 * dragged the split to. Recording the width they last left it at makes the
 * dock ratio a preference rather than a constant.
 */
export async function readWidthRatio(): Promise<number | null> {
  try {
    const n = Number.parseFloat((await Bun.file(join(stateDir(), "width_ratio")).text()).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function writeWidthRatio(ratio: number): Promise<void> {
  // Best-effort: forgetting a width costs one re-dock at the default, so this
  // must never be the thing that stops the widget from being placed.
  await Bun.write(join(stateDir(), "width_ratio"), `${ratio}\n`).catch(() => {});
}

/**
 * Serialise placement across concurrent runs.
 *
 * `tab.focused` and `workspace.focused` both run `follow`, and Herdr fires them
 * **together** — probed at 1ms apart, so two runs read the same layout, both
 * decide the widget needs placing, and both resize it. One nudge lands the width;
 * two land somewhere unpredictable, which is what made a workspace change resize
 * the widget "weirdly".
 *
 * Only one run needs to converge, so the loser exits rather than waiting: the
 * winner is doing the identical work with the same inputs.
 */
export async function takePlacementLock(): Promise<boolean> {
  const path = join(stateDir(), "placing.lock");
  const now = Date.now();
  try {
    // "wx" fails if the file exists, which is the atomic part.
    writeFileSync(path, `${now}\n`, { flag: "wx" });
    return true;
  } catch {
    // Held. Take it over only if the holder cannot still be running.
    let heldSince = Number.NaN;
    try {
      heldSince = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    } catch {
      // Unreadable: treat as stale rather than deadlocking on it.
    }
    if (!lockIsStale(heldSince, now)) return false;
    try {
      writeFileSync(path, `${now}\n`);
      return true;
    } catch {
      return false;
    }
  }
}

export function releasePlacementLock(): void {
  try {
    unlinkSync(join(stateDir(), "placing.lock"));
  } catch {
    // Already gone, or never ours. Either way there is nothing to undo.
  }
}
