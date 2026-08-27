#!/usr/bin/env bun
// The widget itself: a long-lived process owning one pane.
//
// Herdr has no background-poll mechanism for plugins — hooks fire on events
// and actions fire on demand — so the poll loop lives here, in the pane
// process, which is the one part of a plugin that is allowed to stay alive.

import { dirname, join } from "node:path";
import { ignoreWarning, loadConfig } from "../src/config.ts";
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
// Button press/release only (`1000`), never `1002`: motion reports arrive on
// every pixel of every drag across the pane and this widget has nothing to do
// with a drag. `1006` is the SGR encoding — the legacy one caps a coordinate at
// column 223, and the pane can sit in a tab wider than that.
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`;

const cfg = await loadConfig(PLUGIN_ROOT, process.env.HERDR_PLUGIN_CONFIG_DIR);
// Written before the alt screen is entered, so in a Herdr pane it is painted and
// then immediately covered: this is a trail for a pane run directly or one that
// exits early, **not** a message the user will see in passing. The protection
// against a malformed entry is that it is dropped rather than sent — being told
// about it is the lesser half, and this is as far as it goes without spending
// header columns the list wants.
const warning = ignoreWarning(cfg.ignoreDropped);
if (warning) console.error(`herdr-pr-tracker: ${warning}`);

let rows: PrRow[] = [];
let omitted = 0;
let fetchedAt: number | null = null;
let error: string | null = null;
// Which pull requests the pane is listing. Persisted, so the pane comes back in
// the view it was left in; re-read each tick because the toggle action writes
// it from another process.
let view: View = await readView();
// Where the links landed in the frame currently on screen. Rebuilt by every
// paint, because a click has to be tested against what the user is looking at
// rather than what the data now says.
let targets: HitTarget[] = [];
// When the network was last touched, by any route. Declared up here rather than
// beside the loop because `refresh` stamps it: a fetch a click asked for counts
// as the poll for that interval, so the loop does not immediately fetch again.
let lastPoll = 0;

// --- terminal ---------------------------------------------------------------

// Deafen the tty. `-isig` is what stops a stray Ctrl-C or Ctrl-Z killing or
// suspending the widget, and it also neutralises `pane send-keys` aimed here.
// Never `stty raw`: it drops `opost onlcr` and every line stair-steps.
//
// The mouse *is* claimed here — see `src/open.ts` for why that reverses the
// original design, and `handleClick` for what the pane does with it.
function deafen() {
  try {
    Bun.spawnSync(["stty", "-echo", "-icanon", "-isig", "-ixon", "-iexten"], {
      stdin: "inherit",
    });
  } catch {
    // A pane without a controllable tty simply stays interactive; the widget
    // is still readable, which is the part that matters.
  }
}

function geometry(): { cols: number; rows: number } {
  // Herdr resizes the pty, so the process's own idea of its size is the truth.
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
    view,
    // `auto` spends the ten columns on an owner prefix only once a second
    // owner is actually present.
    showOwner: cfg.showOwner === "always" ||
      (cfg.showOwner === "auto" && needsOwner(rows)),
    omitted,
  });
  // Derived from the painted frame, so whatever is hyperlinked is clickable and
  // the two can never disagree.
  targets = hitTargets(lines);
  // Home, then clear to end of screen: clearing the whole screen first makes
  // the pane flicker on every repaint, and a repaint happens every second.
  Bun.write(Bun.stdout, `${ESC}[H${ESC}[J${lines.join("\r\n")}`);
}

/**
 * Which pane this process is drawing into, as of now.
 *
 * `HERDR_PANE_ID` is the id the process was *launched* with, and a cross-tab
 * move renames the pane without restarting or notifying the renderer — probed:
 * a live widget's env said `w23:p1` while the pane was `w23:pX`. So the env var
 * is only the last resort. The recorded id is checked against a
 * live listing first, and the label is the fallback: it is the same
 * discriminator `adoptWidget` uses, and `follow` keeps exactly one pane wearing
 * it.
 */
async function ownPaneId(): Promise<string | null> {
  const panes = await listPanes();
  if (panes.length === 0) return process.env.HERDR_PANE_ID ?? null;
  const recorded = await readPaneId();
  if (recorded && panes.some((p) => p.pane_id === recorded)) return recorded;
  const mine = panes.find((p) => p.label === WIDGET_LABEL && !p.agent);
  return mine?.pane_id ?? process.env.HERDR_PANE_ID ?? null;
}

/**
 * Name the view on the pane header.
 *
 * This is the only place the current view is named outright: the header line
 * inside the pane carries a summary and a control, and columns there are the
 * scarcest thing the widget has. The title costs none of them.
 *
 * Best-effort and never awaited by a paint — a pane that cannot reach Herdr is
 * still a readable list, and a missing title is a cosmetic loss.
 */
async function titlePane(v: View): Promise<void> {
  const id = await ownPaneId();
  if (id) await setPaneTitle(id, VIEW_TITLE[v]);
}

/**
 * Serialised writes of the view marker, with a count of the ones still owed.
 *
 * Two things depend on the ordering. The marker must end up holding the view
 * of the *last* click, so the writes cannot race; and the poll loop reads the
 * marker every tick, so while a click's write is still owed it must not read
 * the superseded value and switch the pane straight back.
 */
let markerWrites: Promise<void> = Promise.resolve();
let markerWritesOwed = 0;
function persistView(v: View) {
  markerWritesOwed += 1;
  markerWrites = markerWrites
    .then(() => writeView(v))
    .catch(() => {
      // The pane already shows the view; a marker that could not be written
      // only costs the preference on the next start.
    })
    .finally(() => {
      markerWritesOwed -= 1;
    });
}

/**
 * The slow half of a switch: the pane title and the fetch for the new view.
 *
 * Runs *behind* the paint rather than in front of it, and each step re-checks
 * that the view it was queued for is still the one on screen, so a click that
 * lands mid-catch-up supersedes it instead of queueing behind it. Serialised
 * for the same reason the marker writes are: two `titlePane` calls in flight
 * at once can land in either order.
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
 * Swap views without waiting for the poll — or for anything else.
 *
 * Only the parts that change what is on screen are awaited: the cached list
 * for the new view, and the paint. The marker write, the pane title and the
 * fetch all run behind it, because each of them is a spawn or a network call
 * and holding the click open across them is what made toggling back and forth
 * feel like a request rather than a button.
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

/**
 * A click landed. Everything hyperlinked is a target; the switcher is the one
 * whose URL the pane recognises as its own.
 *
 * The switcher's URL is GitHub's own list of the same pull requests, so the
 * comparison is what separates "switch the pane" from "open the browser" — and
 * the fallback is the browser, which is what Herdr would have done with this
 * click before the pane claimed the mouse.
 */
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

// A fetch is in flight. The poll loop skips its own turn while one is running,
// so a click's catch-up and the interval poll cannot both hit GitHub for the
// same list a moment apart.
let fetching = false;

/**
 * Fetch one view's list.
 *
 * Takes the view rather than reading the global, and every write back into the
 * globals is guarded on it still being the view on screen: a fetch started for
 * the view you just left must not repaint its rows under the heading of the
 * one you are now looking at. The snapshot is still written either way — it is
 * keyed by view, and a fresher cache for the other view is only ever useful.
 */
async function refresh(target: View) {
  fetching = true;
  lastPoll = Date.now();
  try {
    // The inbound view is deliberately not `fetchPrs` with a different query:
    // it is three searches and a dedup, and its rows carry a reason.
    const list = target === "inbound"
      ? await fetchInbound(cfg.maxPrs, cfg.ignore)
      : await fetchPrs(cfg.searchQuery, cfg.maxPrs, cfg.ignore);
    // Workspace linkage is local and cheap, and a failure to read it must not
    // discard a good PR fetch — so it degrades to "nothing linked".
    let linked = list.rows;
    try {
      linked = linkRows(list.rows, await collectOpenBranches(await listWorkspaces()));
    } catch {
      linked = list.rows;
    }
    const at = Date.now();
    // The cache is keyed by view, so it is written whether or not this view is
    // still the one on screen — a fresher list for the view you just left is
    // exactly what the next switch back wants to paint.
    await writeSnapshot({ fetchedAt: at, rows: linked, omitted: list.omitted }, target);
    if (view !== target) return;
    rows = linked;
    omitted = list.omitted;
    fetchedAt = at;
    error = null;
  } catch (e) {
    // Keep the last good list on screen. The header turns red and says why,
    // and still reports how old the data actually is: showing stale rows as
    // though they were fresh is the one failure this widget must not have.
    if (view === target) error = e instanceof GhError ? e.message : "refresh failed";
  } finally {
    fetching = false;
  }
}

// --- lifecycle --------------------------------------------------------------

function shutdown() {
  // Release the mouse before the alt screen: a pane that exits still holding
  // mouse reporting leaves the *terminal* in that mode, and whatever Herdr puts
  // in this cell next inherits it.
  Bun.write(Bun.stdout, MOUSE_OFF + ALT_SCREEN_OFF);
  process.exit(0);
}

// SIGINT/SIGTERM still arrive from Herdr closing the pane even with -isig,
// which only stops the *tty* from generating them.
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
// A throw anywhere — a paint, the loop, a rejected fetch nothing caught — would
// otherwise take the process out *without* releasing the mouse or the alt
// screen, and the terminal keeps reporting into whatever Herdr puts in this
// cell next. The widget is long-lived enough to outlive plugin reloads, so the
// one exit path that skips `shutdown` is worth closing even though nothing is
// known to reach it.
process.on("uncaughtException", shutdown);
process.on("unhandledRejection", shutdown);
// A resize only needs a repaint, which the loop already does every tick.
process.stdout.on("resize", () => paint());

deafen();
// Read stdin for mouse reports, and discard everything else so anything typed
// or sent at the pane is dropped rather than echoed into the frame. Job control
// is off in a non-interactive process, so reading the pane's own tty here never
// earns a SIGTTIN.
let pending = "";
// One click at a time — but only across the part of a click that touches the
// screen. `switchTo` no longer awaits the title or the fetch, so this is held
// for a snapshot read and a paint rather than for a network round trip, and
// toggling back and forth is limited by how fast the pane can repaint.
let busy = false;
try {
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    const { events, rest } = parseMouse(pending + chunk.toString("binary"));
    pending = rest;
    for (const e of events) {
      // The press, not the release: the release of a drag that started
      // elsewhere lands here too, and only the press says where the click
      // began. Left button only — Herdr keeps the right one for its own menu.
      if (!e.press || e.button !== 0 || busy) continue;
      busy = true;
      handleClick(e.row, e.col).finally(() => {
        busy = false;
      });
    }
  });
  process.stdin.on("error", () => {});
} catch {
  // No readable stdin is fine; there is then nothing to drain, and the widget
  // is still a readable list.
}
Bun.write(Bun.stdout, ALT_SCREEN_ON + MOUSE_ON);

// Show the cached list immediately, correctly labelled with its true age, so a
// restarted widget is never a blank pane for a whole poll interval.
const cached = await readSnapshot(view);
if (cached) {
  rows = cached.rows;
  omitted = cached.omitted;
  fetchedAt = cached.fetchedAt;
}
paint();
// The title is set on start as well as on every change: Herdr reopens the pane
// under a new id after a plugin reload without running `follow`, and that pane
// would otherwise wear the manifest's label until the view next changed.
await titlePane(view);

await refresh(view);

while (true) {
  // The age in the header ticks every second; the network is only touched on
  // the poll interval, or when the refresh action drops a file for us.
  await Bun.sleep(1000);

  let forced = false;
  try {
    if (await Bun.file(REFRESH_FILE).exists()) {
      await Bun.file(REFRESH_FILE).delete();
      forced = true;
    }
  } catch {
    // Nothing to do: a missing or unreadable marker just means no request.
  }

  // The toggle action landed. Swap to that view's cached list and repaint before
  // fetching, so the switch is immediate rather than a pane that keeps showing
  // the old view until the network answers — and never shows one view's rows
  // under the other view's heading.
  //
  // Skipped while a click's marker write is still owed: the click has already
  // applied the new view here, and reading the marker before that write lands
  // would see the superseded value and switch the pane straight back.
  if (markerWritesOwed === 0) {
    const wanted = await readView();
    if (wanted !== view) {
      await switchTo(wanted);
      // `switchTo` has already queued the fetch for the new view.
      continue;
    }
  }

  // A click's catch-up may already be fetching; the poll waits a tick rather
  // than asking GitHub for the same list twice a moment apart.
  if (!fetching && (forced || Date.now() - lastPoll >= cfg.pollSeconds * 1000)) {
    await refresh(view);
  }

  // Repaint every tick regardless, so the relative age stays honest.
  paint();
}
