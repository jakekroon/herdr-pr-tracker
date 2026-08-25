#!/usr/bin/env bun
// The two view actions: "Show my PRs" and "Show PRs to review".
//
// Idempotent rather than a toggle, so each is a promise about what you will be
// looking at afterwards and either can be bound to a key without your having to
// know which view you are in.
//
// Like `refresh`, this does not fetch anything: the pane process owns the poll
// loop and the GitHub call, and two processes fetching would race. It writes
// the preference and lets the renderer pick it up on its next tick. Unlike the
// refresh marker, this one persists — it is a preference, not a request.

import { openWidget } from "../src/herdr.ts";
import { writeView } from "../src/state.ts";
import { isView } from "../src/view.ts";

const requested = Bun.argv[2];
if (!isView(requested)) {
  // This argument comes from the manifest, not from anything the user types,
  // so an unrecognised one is a packaging bug worth failing on.
  console.error(`herdr-pr-tracker: unknown view "${requested ?? ""}"`);
  process.exit(1);
}

await writeView(requested);

// The action's title says what you will see, so it has to be on screen.
process.exit(await openWidget());
