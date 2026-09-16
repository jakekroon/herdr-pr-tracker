#!/usr/bin/env bun
// The `tab.focused` / `workspace.focused` hook entrypoint, and the hand-run one.
//
// Herdr 0.9.0 stopped dispatching these hooks for focus changes made in the TUI
// — see `src/watch.ts`, which is what actually keeps the widget with you. They
// still fire for focus driven over the socket API, which is how a worktree open
// or another agent's `herdr workspace focus` reaches the widget, so this stays.
//
// `"current"` because Herdr hands a hook the tab its event fired for, through
// `HERDR_PANE_ID`.

import { followFocus } from "../src/follow.ts";

process.exit(await followFocus("current"));
