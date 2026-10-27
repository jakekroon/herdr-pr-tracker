#!/usr/bin/env bun
// The "Toggle PR view" action. It writes the view marker and the pane process
// picks it up on its next tick; only the pane fetches.
//
// An explicit view name is also accepted, so a user's `[[keys.command]]` can
// bind "always show me X". `isView` is strict: a mistyped argument is a
// packaging bug.

import { openWidget } from "../src/herdr.ts";
import { readView, writeView } from "../src/state.ts";
import { isView, otherView } from "../src/view.ts";

const requested = Bun.argv[2];
if (requested != null && requested !== "toggle" && !isView(requested)) {
  console.error(`herdr-pr-tracker: unknown view "${requested}"`);
  process.exit(1);
}

// Read the current view here, so a keypress with no widget on screen still lands.
await writeView(isView(requested) ? requested : otherView(await readView()));

process.exit(await openWidget());
