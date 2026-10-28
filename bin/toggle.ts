#!/usr/bin/env bun
// Show or hide the widget. Hiding closes the pane, so a hidden widget runs no
// poll loop. The cached list in the state dir makes reopening instant.

import { closePluginPane, listPanes, openWidget } from "../src/herdr.ts";
import { clearPaneId, readPaneId } from "../src/state.ts";

const known = await readPaneId();
const alive = known ? (await listPanes()).some((p) => p.pane_id === known) : false;

if (alive && known) {
  await closePluginPane(known);
  await clearPaneId();
} else {
  if (known) await clearPaneId();
  process.exit(await openWidget());
}
