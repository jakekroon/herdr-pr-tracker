#!/usr/bin/env bun
// The manual refresh action. The pane process owns the GitHub call, so this
// drops a marker file that the renderer reads within a second. With no widget
// open, the request is dropped.

import { join } from "node:path";
import { readPaneId, stateDir } from "../src/state.ts";

const marker = join(stateDir(), "refresh");

await Bun.write(marker, `${Date.now()}\n`);

// Herdr records stderr in `herdr plugin log`.
if (!(await readPaneId())) {
  console.error("herdr-pr-tracker: no widget pane is open; nothing to refresh");
}
