#!/usr/bin/env bun
// Show or hide the widget.
//
// Hiding closes the pane rather than pausing it, so a hidden widget costs
// nothing: with the pane gone there is no poll loop and no gh calls. The
// cached list in the state dir is what makes reopening instant.

import { closePluginPane, listPanes, openWidget } from "../src/herdr.ts";
import { clearPaneId, readPaneId } from "../src/state.ts";

const known = await readPaneId();
const alive = known ? (await listPanes()).some((p) => p.pane_id === known) : false;

if (alive && known) {
  await closePluginPane(known);
  await clearPaneId();
} else {
  // A recorded id for a pane that no longer exists is stale; clear it so
  // follow opens a fresh one rather than trying to move a ghost.
  if (known) await clearPaneId();
  process.exit(await openWidget());
}
