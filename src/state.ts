// The renderer is long-lived, so it holds the PR list in memory. This module
// exists for the case that is easy to get wrong: a restart. Without a cached
// last-good result, toggling the widget shows an empty pane for a whole poll
// interval, which is indistinguishable from "you have no open PRs".

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lockIsStale } from "./dock.ts";
import type { PrRow } from "./model.ts";
import { DEFAULT_VIEW, parseView, snapshotFile, type View } from "./view.ts";

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

// Keyed by view: one shared file would paint the authored list under the
// inbound heading for a whole fetch after reopening in the inbound view.
const snapshotPath = (view: View) => join(stateDir(), snapshotFile(view));

export async function readSnapshot(view: View = DEFAULT_VIEW): Promise<Snapshot | null> {
  try {
    const raw = await Bun.file(snapshotPath(view)).json();
    if (typeof raw?.fetchedAt !== "number" || !Array.isArray(raw?.rows)) return null;
    return { fetchedAt: raw.fetchedAt, rows: raw.rows, omitted: raw.omitted ?? 0 };
  } catch {
    // A missing, truncated or half-written file is a cold start, not an error.
    return null;
  }
}

export async function writeSnapshot(s: Snapshot, view: View = DEFAULT_VIEW): Promise<void> {
  const path = snapshotPath(view);
  try {
    // Write-then-rename so a renderer killed mid-write cannot leave a
    // truncated file that reads as "no open PRs" on the next start.
    //
    // `renameSync`, and deliberately not `Bun.write(path, Bun.file(tmp))`:
    // probed — that copies onto the destination's *existing inode*
    // rather than renaming — the destination is truncated in place, which is
    // exactly the window this is meant to close. Nothing in Bun's write API
    // renames, so the atomic step comes from `node:fs`.
    const tmp = `${path}.tmp`;
    await Bun.write(tmp, JSON.stringify(s));
    renameSync(tmp, path);
  } catch {
    // Caching is a convenience; failing to cache must never break the pane.
  }
}

/**
 * The chosen view, persisted so it outlives the pane process.
 *
 * The pane owns the poll loop, so the toggle action cannot fetch anything
 * itself without racing it — it writes here instead and the renderer picks the
 * change up on its next tick, the same shape as the refresh marker. Unlike that
 * marker this one is *not* deleted on read: it is a preference, not a request.
 */
export async function readView(): Promise<View> {
  try {
    return parseView(await Bun.file(join(stateDir(), "view")).text());
  } catch {
    // No marker is the authored view, which is the one the plugin has always
    // had. Never an error: an unreadable preference must not stop the widget.
    return DEFAULT_VIEW;
  }
}

export async function writeView(view: View): Promise<void> {
  await Bun.write(join(stateDir(), "view"), `${view}\n`);
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
 * What is remembered about the widget's width in one tab, as fractions of it.
 *
 * `width` is the width the user left the widget at in that tab. It is kept per
 * tab, not once for all of them: a global width meant that a split in one tab,
 * which narrows the widget, was recorded as a drag and then imposed on every
 * other tab the widget visited. A tab with no record docks at the default.
 *
 * `placed` is the width the last placement in that tab actually reached, as
 * opposed to the one it aimed at. `pane resize` is layout-dependent and a walk
 * can stop short, and without this the next settled run would measure the
 * shortfall and record it as though the user had chosen it. See
 * `shouldRecordWidth`.
 *
 * `stack` is the pane the widget shared its column with when it last left the
 * tab, if the user had split the widget's pane top and bottom. See
 * `stackPartner`.
 */
export interface TabWidth {
  width: number | null;
  placed: number | null;
  stack: { pane: string; keep: number } | null;
}

const widthsPath = () => join(stateDir(), "widths.json");

function readWidths(): Record<string, Partial<TabWidth>> {
  try {
    const raw = JSON.parse(readFileSync(widthsPath(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

const finite = (n: unknown): number | null =>
  typeof n === "number" && Number.isFinite(n) ? n : null;

export function readTabWidth(tabId: string | undefined): TabWidth {
  const entry = tabId == null ? undefined : readWidths()[tabId];
  const stack = entry?.stack;
  return {
    width: finite(entry?.width),
    placed: finite(entry?.placed),
    stack:
      typeof stack?.pane === "string" && finite(stack?.keep) != null
        ? { pane: stack.pane, keep: stack.keep }
        : null,
  };
}

function updateTabWidth(tabId: string | undefined, change: (entry: Partial<TabWidth>) => void): void {
  if (tabId == null) return;
  // Best-effort: forgetting a width costs one dock at the default, so this must
  // never be the thing that stops the widget from being placed. Written
  // rename-style, because a truncated file would forget every tab at once.
  try {
    const all = readWidths();
    const entry = { ...all[tabId] };
    change(entry);
    all[tabId] = entry;
    const path = widthsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(all));
    renameSync(`${path}.tmp`, path);
  } catch {}
}

/** The user chose this width here, so the last placement's shortfall no longer
 * explains anything. */
export function recordTabWidth(tabId: string | undefined, ratio: number): void {
  updateTabWidth(tabId, (e) => {
    e.width = ratio;
    delete e.placed;
  });
}

export function recordStack(tabId: string | undefined, stack: TabWidth["stack"]): void {
  updateTabWidth(tabId, (e) => {
    if (stack == null) delete e.stack;
    else e.stack = stack;
  });
}

export function recordPlacedWidth(tabId: string | undefined, ratio: number | null): void {
  updateTabWidth(tabId, (e) => {
    if (ratio == null) delete e.placed;
    else e.placed = ratio;
  });
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
    // Every other writer here goes through `Bun.write`, which creates parents;
    // this one cannot, because "wx" is the atomic part and `Bun.write` has no
    // exclusive flag. So it has to make the directory itself. Without this, a
    // checkout Herdr has never run — `bun bin/follow.ts` by hand — ENOENTs on
    // both writes below and `follow` exits 0 having placed nothing, silently.
    mkdirSync(dirname(path), { recursive: true });
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

/**
 * Whether a placement is in flight right now.
 *
 * The settled path deliberately does not *take* the lock — two runs both
 * deciding not to act cannot conflict — but it does have to know when another
 * run is mid-walk. Measured 2026-08-25: closing and re-docking the widget let a
 * hook-fired settled run measure the pane while `applyWidth` was still stepping
 * it, read `placed_ratio` before the placing run had written it, and record the
 * half-walked width as the user's preference. `placed_ratio` cannot cover that
 * window on its own because it is only written once the walk has finished.
 */
export function placementInFlight(): boolean {
  try {
    const heldSince = Number.parseInt(
      readFileSync(join(stateDir(), "placing.lock"), "utf8").trim(),
      10,
    );
    return !lockIsStale(heldSince, Date.now());
  } catch {
    // No lock file, or an unreadable one: nothing is provably in flight.
    return false;
  }
}

export function releasePlacementLock(): void {
  try {
    unlinkSync(join(stateDir(), "placing.lock"));
  } catch {
    // Already gone, or never ours. Either way there is nothing to undo.
  }
}
