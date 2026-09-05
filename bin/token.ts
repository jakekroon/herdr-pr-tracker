#!/usr/bin/env bun
// Writes the sidebar `$pr` token for one pane's branch.
//
// This is the responsibility inherited from the gh-pr plugin this one replaces:
// without it, `$pr` in the user's sidebar row config goes blank and replacing
// gh-pr would be a downgrade.

import { join } from "node:path";
import { fetchBranchChecks, fetchBranchPr } from "../src/gh.ts";
import { clearToken, currentPane, listPanes, type PaneInfo, setToken } from "../src/herdr.ts";
import { loadConfig } from "../src/config.ts";
import { stateDir } from "../src/state.ts";
import { refreshingLabel, resolvePaneCwd, rollupBuckets, tokenLabel } from "../src/token.ts";

const TOKEN = "pr";

/** The pane the hook fired for. Herdr sets HERDR_PANE_ID on pane-scoped hooks;
 * an action invoked from a workspace context has none, so fall back to asking
 * which pane is focused. */
async function targetPane(): Promise<PaneInfo | null> {
  const id = process.env.HERDR_PANE_ID;
  if (!id) return await currentPane();
  const pane = (await listPanes()).find((p) => p.pane_id === id);
  return pane ?? (await currentPane());
}

async function branchOf(cwd: string): Promise<string | null> {
  const p = Bun.spawn(["git", "-C", cwd, "symbolic-ref", "--short", "HEAD"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  // A detached HEAD has no branch, so there is no PR to name.
  return code === 0 ? out.trim() || null : null;
}

/** Per-pane throttle. Focus events fire far more often than a PR's state
 * changes, and every lookup is two `gh` subprocesses. */
async function throttled(paneId: string, seconds: number): Promise<boolean> {
  if (seconds <= 0) return false;
  const stamp = join(stateDir(), `throttle-${paneId.replace(/[^\w.-]/g, "_")}`);
  try {
    const text = await Bun.file(stamp).text();
    const last = Number.parseInt(text.trim(), 10);
    if (Number.isFinite(last) && Date.now() - last < seconds * 1000) return true;
  } catch {
    // No stamp yet: not throttled.
  }
  await Bun.write(stamp, String(Date.now()));
  return false;
}

const pane = await targetPane();
if (!pane) process.exit(0);

const cwd = resolvePaneCwd(pane);
if (!cwd) process.exit(0);

// Only agent panes carry the sidebar row this token appears in, so a plain
// shell pane is not worth two gh calls.
if (!pane.agent) process.exit(0);

const cfg = await loadConfig(
  process.env.HERDR_PLUGIN_ROOT ?? ".",
  process.env.HERDR_PLUGIN_CONFIG_DIR,
);
// A manual invocation should always do the work; only the automatic hook path
// is throttled.
const automatic = Boolean(process.env.HERDR_PLUGIN_EVENT_JSON);
if (automatic && (await throttled(pane.pane_id, cfg.tokenThrottleSeconds))) {
  process.exit(0);
}

const branch = await branchOf(cwd);
if (!branch) {
  await clearToken(pane.pane_id, TOKEN);
  process.exit(0);
}

// Keep the number visible while the lookup runs, so the sidebar shows work in
// progress rather than appearing to hang on a stale glyph.
const pending = refreshingLabel(pane.tokens?.[TOKEN], false, cfg.glyphs);
if (pending) await setToken(pane.pane_id, TOKEN, pending);

const pr = await fetchBranchPr(cwd, branch);
if (!pr || pr.state !== "OPEN") {
  // A merged or closed PR is not something this plugin tracks, and a stale
  // `#123 ✓` beside a merged branch is worse than no token at all.
  await clearToken(pane.pane_id, TOKEN);
  process.exit(0);
}

const ci = rollupBuckets(await fetchBranchChecks(cwd, branch));
await setToken(pane.pane_id, TOKEN, tokenLabel({ number: pr.number, ci, isDraft: pr.isDraft }, cfg.glyphs));
