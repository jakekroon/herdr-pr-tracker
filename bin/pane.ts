#!/usr/bin/env bun
// The widget itself: a long-lived process owning one pane.
//
// Herdr has no background-poll mechanism for plugins — hooks fire on events
// and actions fire on demand — so the poll loop lives here, in the pane
// process, which is the one part of a plugin that is allowed to stay alive.

import { dirname, join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { fetchPrs, GhError } from "../src/gh.ts";
import { listWorkspaces } from "../src/herdr.ts";
import type { PrRow } from "../src/model.ts";
import { needsOwner } from "../src/model.ts";
import { render } from "../src/render.ts";
import { readSnapshot, stateDir, writeSnapshot } from "../src/state.ts";
import { collectOpenBranches, linkRows } from "../src/workspaces.ts";

const PLUGIN_ROOT = process.env.HERDR_PLUGIN_ROOT ?? dirname(import.meta.dir);
const REFRESH_FILE = join(stateDir(), "refresh");

const ESC = "\x1b";
const ALT_SCREEN_ON = `${ESC}[?1049h${ESC}[?25l`;
const ALT_SCREEN_OFF = `${ESC}[0m${ESC}[?1049l${ESC}[?25h`;

const cfg = await loadConfig(PLUGIN_ROOT, process.env.HERDR_PLUGIN_CONFIG_DIR);

let rows: PrRow[] = [];
let omitted = 0;
let fetchedAt: number | null = null;
let error: string | null = null;

// --- terminal ---------------------------------------------------------------

// Deafen the tty. `-isig` is what stops a stray Ctrl-C or Ctrl-Z killing or
// suspending the widget, and it also neutralises `pane send-keys` aimed here.
// Never `stty raw`: it drops `opost onlcr` and every line stair-steps.
//
// The mouse is deliberately NOT claimed (no `?1002h`). Claiming it would make
// the pane swallow clicks, which is exactly what must reach Herdr for the OSC 8
// hyperlink on each title to be clickable.
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
    // `auto` spends the ten columns on an owner prefix only once a second
    // owner is actually present.
    showOwner: cfg.showOwner === "always" ||
      (cfg.showOwner === "auto" && needsOwner(rows)),
    omitted,
  });
  // Home, then clear to end of screen: clearing the whole screen first makes
  // the pane flicker on every repaint, and a repaint happens every second.
  Bun.write(Bun.stdout, `${ESC}[H${ESC}[J${lines.join("\r\n")}`);
}

// --- data -------------------------------------------------------------------

async function refresh() {
  try {
    const list = await fetchPrs(cfg.searchQuery, cfg.maxPrs);
    // Workspace linkage is local and cheap, and a failure to read it must not
    // discard a good PR fetch — so it degrades to "nothing linked".
    let linked = list.rows;
    try {
      linked = linkRows(list.rows, await collectOpenBranches(await listWorkspaces()));
    } catch {
      linked = list.rows;
    }
    rows = linked;
    omitted = list.omitted;
    fetchedAt = Date.now();
    error = null;
    await writeSnapshot({ fetchedAt, rows, omitted });
  } catch (e) {
    // Keep the last good list on screen. The header turns red and says why,
    // and still reports how old the data actually is: showing stale rows as
    // though they were fresh is the one failure this widget must not have.
    error = e instanceof GhError ? e.message : "refresh failed";
  }
}

// --- lifecycle --------------------------------------------------------------

function shutdown() {
  Bun.write(Bun.stdout, ALT_SCREEN_OFF);
  process.exit(0);
}

// SIGINT/SIGTERM still arrive from Herdr closing the pane even with -isig,
// which only stops the *tty* from generating them.
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
// A resize only needs a repaint, which the loop already does every tick.
process.stdout.on("resize", () => paint());

deafen();
// Drain stdin so anything typed or sent at the pane is discarded rather than
// echoed into the frame. Job control is off in a non-interactive process, so
// reading the pane's own tty here never earns a SIGTTIN.
try {
  process.stdin.resume();
  process.stdin.on("data", () => {});
  process.stdin.on("error", () => {});
} catch {
  // No readable stdin is fine; there is then nothing to drain.
}
Bun.write(Bun.stdout, ALT_SCREEN_ON);

// Show the cached list immediately, correctly labelled with its true age, so a
// restarted widget is never a blank pane for a whole poll interval.
const cached = await readSnapshot();
if (cached) {
  rows = cached.rows;
  omitted = cached.omitted;
  fetchedAt = cached.fetchedAt;
}
paint();

await refresh();

let lastPoll = Date.now();
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

  if (forced || Date.now() - lastPoll >= cfg.pollSeconds * 1000) {
    lastPoll = Date.now();
    await refresh();
  }

  // Repaint every tick regardless, so the relative age stays honest.
  paint();
}
