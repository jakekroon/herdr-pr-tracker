// Without a cached last-good list, a restarted pane shows nothing for a whole
// poll interval, and an empty pane reads as "you have no open PRs".

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

const snapshotPath = (view: View) => join(stateDir(), snapshotFile(view));

export async function readSnapshot(view: View = DEFAULT_VIEW): Promise<Snapshot | null> {
  try {
    const raw = await Bun.file(snapshotPath(view)).json();
    if (typeof raw?.fetchedAt !== "number" || !Array.isArray(raw?.rows)) return null;
    return { fetchedAt: raw.fetchedAt, rows: raw.rows, omitted: raw.omitted ?? 0 };
  } catch {
    // A missing or truncated file is a cold start.
    return null;
  }
}

export async function writeSnapshot(s: Snapshot, view: View = DEFAULT_VIEW): Promise<void> {
  const path = snapshotPath(view);
  try {
    // Write-then-rename, so a renderer killed mid-write leaves no truncated
    // file. Use `renameSync`: `Bun.write(path, Bun.file(tmp))` copies onto the
    // destination's existing inode and truncates it in place.
    const tmp = `${path}.tmp`;
    await Bun.write(tmp, JSON.stringify(s));
    renameSync(tmp, path);
  } catch {
    // A failed cache write must not break the pane.
  }
}

/**
 * The toggle action writes the view marker and the renderer reads it each tick.
 * The renderer keeps the marker after it reads it, because it is a preference.
 */
export async function readView(): Promise<View> {
  try {
    return parseView(await Bun.file(join(stateDir(), "view")).text());
  } catch {
    // An unreadable preference must not stop the widget.
    return DEFAULT_VIEW;
  }
}

export async function writeView(view: View): Promise<void> {
  await Bun.write(join(stateDir(), "view"), `${view}\n`);
}

/** `follow` reads this to move the existing widget instead of opening a second one. */
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
 * The widget's width in one tab, as fractions of the tab.
 *
 * `width` is the width the user left it at. Each tab keeps its own, so a split
 * that narrows the widget in one tab does not change the others.
 *
 * `placed` is the width the last placement reached. A walk can stop short, and
 * `shouldRecordWidth` uses this to refuse that shortfall as a preference.
 *
 * `stack` is the pane that shared the widget's column when it left the tab. See
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
  // Best-effort: a lost width costs one dock at the default. Write-then-rename,
  // because a truncated file forgets every tab.
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

/** A user-chosen width replaces the last placement's shortfall. */
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
 * Herdr fires `tab.focused` and `workspace.focused` about 1ms apart, and both
 * run `follow`. Two concurrent resizes land the widget at an unpredictable
 * width. The loser exits, because the winner does the same work.
 */
export async function takePlacementLock(): Promise<boolean> {
  const path = join(stateDir(), "placing.lock");
  const now = Date.now();
  try {
    // `Bun.write` creates parents but has no exclusive flag, so this writer
    // makes the directory itself. Without it, a hand-run `bun bin/follow.ts`
    // on a fresh checkout exits 0 and places nothing.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${now}\n`, { flag: "wx" });
    return true;
  } catch {
    // Held. Take it over only if the holder cannot still be running.
    let heldSince = Number.NaN;
    try {
      heldSince = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    } catch {
      // Unreadable: treat as stale to avoid a deadlock.
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
 * The settled path does not take the lock, but it must not record a width
 * while another run's `applyWidth` walk is still in progress. The `placed`
 * width is written only after the walk ends, so it cannot cover that window.
 */
export function placementInFlight(): boolean {
  try {
    const heldSince = Number.parseInt(
      readFileSync(join(stateDir(), "placing.lock"), "utf8").trim(),
      10,
    );
    return !lockIsStale(heldSince, Date.now());
  } catch {
    return false;
  }
}

export function releasePlacementLock(): void {
  try {
    unlinkSync(join(stateDir(), "placing.lock"));
  } catch {}
}
