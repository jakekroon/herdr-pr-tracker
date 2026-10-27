#!/usr/bin/env bun
// The widget: a long-lived process that owns one pane. Herdr gives plugins no
// background poll, so the poll loop lives here.

import { dirname, join } from "node:path";
import { configNotice, configWarnings, loadConfig } from "../src/config.ts";
import { fetchInbound, fetchPrs, GhError } from "../src/gh.ts";
import { listPanes, listWorkspaces, setPaneTitle } from "../src/herdr.ts";
import type { PrRow } from "../src/model.ts";
import { needsOwner } from "../src/model.ts";
import { type HitTarget, hitAt, hitTargets, render } from "../src/render.ts";
import { parseMouse } from "../src/mouse.ts";
import { openUrl } from "../src/open.ts";
import {
  readPaneId,
  readSnapshot,
  readView,
  stateDir,
  writeSnapshot,
  writeView,
} from "../src/state.ts";
import { otherView, type View, VIEW_TITLE, viewUrl } from "../src/view.ts";
import { WIDGET_LABEL } from "../src/dock.ts";
import { collectOpenBranches, linkRows } from "../src/workspaces.ts";

const PLUGIN_ROOT = process.env.HERDR_PLUGIN_ROOT ?? dirname(import.meta.dir);
const REFRESH_FILE = join(stateDir(), "refresh");

const ESC = "\x1b";
const ALT_SCREEN_ON = `${ESC}[?1049h${ESC}[?25l`;
const ALT_SCREEN_OFF = `${ESC}[0m${ESC}[?1049l${ESC}[?25h`;
// Press and release only (`1000`). `1002` would report every pixel of a drag.
// `1006` is the SGR encoding, which has no column-223 cap.
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`;

const cfg = await loadConfig(PLUGIN_ROOT, process.env.HERDR_PLUGIN_CONFIG_DIR);
// The alt screen covers this line in a Herdr pane. It is for a pane run by hand
// or one that exits early; the in-pane notice is what the user sees.
for (const warning of configWarnings(cfg)) console.error(`herdr-pr-tracker: ${warning}`);
const startupNotice = configNotice(cfg);
// One list, so both views subtract repositories and authors alike.
const ignore = [...cfg.ignore, ...cfg.ignoreAuthors];

let rows: PrRow[] = [];
let omitted = 0;
let fetchedAt: number | null = null;
let error: string | null = null;
// Re-read each tick, because the toggle action writes it from another process.
let view: View = await readView();
// Rebuilt by every paint: a click is tested against the frame on screen.
let targets: HitTarget[] = [];
// Stamped by `refresh`, so a fetch a click asked for counts as that interval's poll.
let lastPoll = 0;

// --- terminal ---------------------------------------------------------------

// `-isig` stops a stray Ctrl-C or Ctrl-Z, and `pane send-keys`, from killing the
// widget. Never `stty raw`: it drops `opost onlcr` and every line stair-steps.
function deafen() {
  try {
    Bun.spawnSync(["stty", "-echo", "-icanon", "-isig", "-ixon", "-iexten"], {
      stdin: "inherit",
    });
  } catch {}
}

function geometry(): { cols: number; rows: number } {
  const cols = process.stdout.columns ?? 44;
  const lines = process.stdout.rows ?? 24;
  return { cols: Math.max(12, cols), rows: Math.max(1, lines) };
}

function paint() {
  const { cols, rows: height } = geometry();
  const lines = render(rows, {
    cols,
    rows: height,
    now: Date.now(),
    fetchedAt,
    error,
    pollSeconds: cfg.pollSeconds,
    colour: cfg.colour,
    glyphs: cfg.glyphs,
    view,
    showOwner: cfg.showOwner === "always" ||
      (cfg.showOwner === "auto" && needsOwner(rows)),
    omitted,
    notice: startupNotice,
  });
  // Derived from the painted frame, so the hit map cannot drift from what is drawn.
  targets = hitTargets(lines);
  // Home, then clear to end: a full clear first flickers on every repaint.
  Bun.write(Bun.stdout, `${ESC}[H${ESC}[J${lines.join("\r\n")}`);
}

/**
 * A cross-tab move renames the pane without telling this process, so
 * `HERDR_PANE_ID` holds the launch id and is the last resort. Try the recorded
 * id against a live listing first, then `WIDGET_LABEL`.
 */
async function ownPaneId(): Promise<string | null> {
  const panes = await listPanes();
  if (panes.length === 0) return process.env.HERDR_PANE_ID ?? null;
  const recorded = await readPaneId();
  if (recorded && panes.some((p) => p.pane_id === recorded)) return recorded;
  const mine = panes.find((p) => p.label === WIDGET_LABEL && !p.agent);
  return mine?.pane_id ?? process.env.HERDR_PANE_ID ?? null;
}

/** Name the view on the pane header. Never awaited by a paint. */
async function titlePane(v: View): Promise<void> {
  const id = await ownPaneId();
  if (id) await setPaneTitle(id, VIEW_TITLE[v]);
}

/**
 * Serialised view-marker writes, with a count of those still owed. The marker
 * must end on the last click's view, and the poll loop must not read it while a
 * write is owed, or it switches the pane straight back.
 */
let markerWrites: Promise<void> = Promise.resolve();
let markerWritesOwed = 0;
function persistView(v: View) {
  markerWritesOwed += 1;
  markerWrites = markerWrites
    .then(() => writeView(v))
    .catch(() => {})
    .finally(() => {
      markerWritesOwed -= 1;
    });
}

/**
 * The slow half of a switch: pane title, then fetch. Each step re-checks the
 * view, so a later click supersedes it. Serialised, because two `titlePane`
 * calls in flight can land in either order.
 */
let catchUps: Promise<void> = Promise.resolve();
function catchUpTo(v: View) {
  catchUps = catchUps
    .then(async () => {
      if (view !== v) return;
      await titlePane(v);
      if (view !== v) return;
      await refresh(v);
      if (view === v) paint();
    })
    .catch(() => {});
}

/**
 * Swap views. Only the cached-list read and the paint are awaited; the marker
 * write, title and fetch run behind them, so a quick second click still lands.
 */
async function switchTo(next: View) {
  view = next;
  const seen = await readSnapshot(view);
  rows = seen?.rows ?? [];
  omitted = seen?.omitted ?? 0;
  fetchedAt = seen?.fetchedAt ?? null;
  error = null;
  paint();
  persistView(view);
  catchUpTo(view);
}

/** The switcher's URL changes the view; every other link opens in the browser. */
async function handleClick(row: number, col: number) {
  const hit = hitAt(targets, row, col);
  if (!hit) return;
  if (hit.url === viewUrl(otherView(view))) {
    await switchTo(otherView(view));
    return;
  }
  openUrl(hit.url);
}

// --- data -------------------------------------------------------------------

// The poll loop skips its turn while a fetch runs, so a click's catch-up and the
// interval poll do not fetch the same list a moment apart.
let fetching = false;

/**
 * Fetch one view's list. Writes to the globals only if `target` is still on
 * screen, so a late fetch never paints rows under the other view's heading. The
 * snapshot is per view, so it is written either way.
 */
async function refresh(target: View) {
  fetching = true;
  lastPoll = Date.now();
  try {
    const list = target === "inbound"
      ? await fetchInbound(cfg.maxPrs, ignore, cfg.maxIdleDays)
      : await fetchPrs(cfg.searchQuery, cfg.maxPrs, ignore, cfg.maxIdleDays);
    // A workspace read failure must not discard a good PR fetch.
    let linked = list.rows;
    try {
      linked = linkRows(list.rows, await collectOpenBranches(await listWorkspaces()));
    } catch {
      linked = list.rows;
    }
    const at = Date.now();
    await writeSnapshot({ fetchedAt: at, rows: linked, omitted: list.omitted }, target);
    if (view !== target) return;
    rows = linked;
    omitted = list.omitted;
    fetchedAt = at;
    error = null;
  } catch (e) {
    // Keep the last good list. The header turns red and still shows the data's
    // real age, so stale rows never pass as fresh.
    if (view === target) error = e instanceof GhError ? e.message : "refresh failed";
  } finally {
    fetching = false;
  }
}

// --- lifecycle --------------------------------------------------------------

function shutdown() {
  // Release the mouse before the alt screen, or the terminal keeps reporting
  // into whatever Herdr puts in this cell next.
  Bun.write(Bun.stdout, MOUSE_OFF + ALT_SCREEN_OFF);
  process.exit(0);
}

// `-isig` stops only the tty from sending these; Herdr still sends them on close.
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
// Any other exit would skip `shutdown` and leave the terminal in mouse mode.
process.on("uncaughtException", shutdown);
process.on("unhandledRejection", shutdown);
// A resize needs only a repaint, which the loop does every tick.
process.stdout.on("resize", () => paint());

deafen();
// Read stdin for mouse reports and drop everything else, so typed input never
// echoes into the frame.
let pending = "";
// One click at a time. It holds only for a snapshot read and a paint.
let busy = false;
try {
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    const { events, rest } = parseMouse(pending + chunk.toString("binary"));
    pending = rest;
    for (const e of events) {
      // The press, because a drag that started elsewhere releases here too.
      // Left button only: Herdr keeps the right one for its own menu.
      if (!e.press || e.button !== 0 || busy) continue;
      busy = true;
      handleClick(e.row, e.col).finally(() => {
        busy = false;
      });
    }
  });
  process.stdin.on("error", () => {});
} catch {}
Bun.write(Bun.stdout, ALT_SCREEN_ON + MOUSE_ON);

// Paint the cached list at once, with its true age, so a restart is never blank.
const cached = await readSnapshot(view);
if (cached) {
  rows = cached.rows;
  omitted = cached.omitted;
  fetchedAt = cached.fetchedAt;
}
paint();
// A plugin reload reopens the pane under a new id without running `follow`, so
// the title is set on start too.
await titlePane(view);

await refresh(view);

while (true) {
  // The age ticks every second; the network is touched only on the poll
  // interval or when the refresh action drops its marker.
  await Bun.sleep(1000);

  let forced = false;
  try {
    if (await Bun.file(REFRESH_FILE).exists()) {
      await Bun.file(REFRESH_FILE).delete();
      forced = true;
    }
  } catch {}

  // The toggle action changed the view. Skip the read while a click's marker
  // write is owed, or the superseded value switches the pane straight back.
  if (markerWritesOwed === 0) {
    const wanted = await readView();
    if (wanted !== view) {
      // `switchTo` queues the fetch for the new view.
      await switchTo(wanted);
      continue;
    }
  }

  if (!fetching && (forced || Date.now() - lastPoll >= cfg.pollSeconds * 1000)) {
    await refresh(view);
  }

  paint();
}
