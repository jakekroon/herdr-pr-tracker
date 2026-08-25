#!/usr/bin/env bun
// The view action: "Toggle PR view".
//
// One action rather than two idempotent ones, because the pane now *says* which
// view it is in — Herdr paints `VIEW_TITLE` on the pane header — so a control
// that promises a destination is naming a fact already on screen. A toggle is
// also the shape the header switcher and the link handlers already have: two
// views means "the other one" is unambiguous.
//
// An explicit view name is still accepted as an argument, so a user's
// `[[keys.command]]` can bind "always show me X" rather than "swap". Nothing in
// the manifest passes one, but `isView` stays strict on what it does accept: a
// mistyped argument is a packaging bug, not something to interpret.
//
// Like `refresh`, this does not fetch anything: the pane process owns the poll
// loop and the GitHub call, and two processes fetching would race. It writes
// the preference and lets the renderer pick it up on its next tick. Unlike the
// refresh marker, this one persists — it is a preference, not a request.

import { openWidget } from "../src/herdr.ts";
import { readView, writeView } from "../src/state.ts";
import { isView, otherView } from "../src/view.ts";

const requested = Bun.argv[2];
if (requested != null && requested !== "toggle" && !isView(requested)) {
  console.error(`herdr-pr-tracker: unknown view "${requested}"`);
  process.exit(1);
}

// No argument, or "toggle": whichever view is not the current one. Read here
// rather than in the pane, so a keypress with no widget on screen still lands.
await writeView(isView(requested) ? requested : otherView(await readView()));

// The action changes what you are looking at, so it has to be on screen.
process.exit(await openWidget());
