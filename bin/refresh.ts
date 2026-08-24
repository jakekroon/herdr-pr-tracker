#!/usr/bin/env bun
// The manual refresh action.
//
// The pane process owns the poll loop and the GitHub call, so this does not
// fetch anything itself — two processes fetching would race and the widget
// would flicker between two answers. It drops a marker file the renderer picks
// up within a second, which also means a refresh requested while the widget is
// closed is simply forgotten rather than queued.

import { join } from "node:path";
import { readPaneId, stateDir } from "../src/state.ts";

const marker = join(stateDir(), "refresh");

// The renderer deletes the marker as it acts on it, so writing it twice in
// quick succession collapses into one refresh rather than two.
await Bun.write(marker, `${Date.now()}\n`);

// If no widget is running there is nothing to refresh; say so on stderr, which
// Herdr records in `herdr plugin log` rather than showing in a pane.
if (!(await readPaneId())) {
  console.error("herdr-pr-tracker: no widget pane is open; nothing to refresh");
}
