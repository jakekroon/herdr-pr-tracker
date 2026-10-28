#!/usr/bin/env bun
// Writes the sidebar `$pr` token for one pane's branch.

import { join } from "node:path";
import { fetchBranchChecks, fetchBranchPr } from "../src/gh.ts";
import { clearToken, currentPane, listPanes, type PaneInfo, setToken } from "../src/herdr.ts";
import { loadConfig } from "../src/config.ts";
import { stateDir } from "../src/state.ts";
import { refreshingLabel, resolvePaneCwd, rollupBuckets, tokenLabel } from "../src/token.ts";

const TOKEN = "pr";

/** An action invoked from a workspace context has no HERDR_PANE_ID, so fall
 * back to the focused pane. */
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
  return code === 0 ? out.trim() || null : null;
}

/** Focus events fire far more often than a PR changes, and each lookup costs
 * two `gh` calls. */
async function throttled(paneId: string, seconds: number): Promise<boolean> {
  if (seconds <= 0) return false;
  const stamp = join(stateDir(), `throttle-${paneId.replace(/[^\w.-]/g, "_")}`);
  try {
    const text = await Bun.file(stamp).text();
    const last = Number.parseInt(text.trim(), 10);
    if (Number.isFinite(last) && Date.now() - last < seconds * 1000) return true;
  } catch {}
  await Bun.write(stamp, String(Date.now()));
  return false;
}

const pane = await targetPane();
if (!pane) process.exit(0);

const cwd = resolvePaneCwd(pane);
if (!cwd) process.exit(0);

// Only agent panes carry the sidebar row this token appears in.
if (!pane.agent) process.exit(0);

const cfg = await loadConfig(
  process.env.HERDR_PLUGIN_ROOT ?? ".",
  process.env.HERDR_PLUGIN_CONFIG_DIR,
);
// Only the automatic hook path is throttled.
const automatic = Boolean(process.env.HERDR_PLUGIN_EVENT_JSON);
if (automatic && (await throttled(pane.pane_id, cfg.tokenThrottleSeconds))) {
  process.exit(0);
}

const branch = await branchOf(cwd);
if (!branch) {
  await clearToken(pane.pane_id, TOKEN);
  process.exit(0);
}

const pending = refreshingLabel(pane.tokens?.[TOKEN], false, cfg.glyphs);
if (pending) await setToken(pane.pane_id, TOKEN, pending);

const pr = await fetchBranchPr(cwd, branch);
if (!pr || pr.state !== "OPEN") {
  await clearToken(pane.pane_id, TOKEN);
  process.exit(0);
}

const ci = rollupBuckets(await fetchBranchChecks(cwd, branch));
await setToken(pane.pane_id, TOKEN, tokenLabel({ number: pr.number, ci, isDraft: pr.isDraft }, cfg.glyphs));
