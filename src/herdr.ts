// The only module that talks to Herdr. Every call is best-effort: a failed call
// returns null instead of crashing the pane.

const HERDR = process.env.HERDR_BIN_PATH ?? "herdr";

/** Falls back to the manifest's id for a hand-run. */
export const PLUGIN_ID = process.env.HERDR_PLUGIN_ID ?? "herdr-pr-tracker";

/** Herdr scopes tokens to a source, so two plugins cannot overwrite each
 * other's token of the same name. */
export const METADATA_SOURCE = `plugin:${PLUGIN_ID}`;

async function call(args: string[]): Promise<unknown | null> {
  try {
    const p = Bun.spawn([HERDR, ...args], { stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (code !== 0) return null;
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** Herdr's CLI wraps every reply as `{id, result: {...}}`. */
function result(payload: unknown): Record<string, unknown> | null {
  const r = (payload as { result?: unknown } | null)?.result;
  return r && typeof r === "object" ? (r as Record<string, unknown>) : null;
}

export interface PaneInfo {
  pane_id: string;
  tab_id?: string;
  workspace_id?: string;
  cwd?: string;
  foreground_cwd?: string;
  focused?: boolean;
  /** For a plugin pane, the manifest's `[[panes]].title`. */
  label?: string;
  agent?: string;
  scroll?: { viewport_rows?: number };
  state_labels?: Record<string, string>;
  tokens?: Record<string, string>;
}

export async function listPanes(): Promise<PaneInfo[]> {
  const r = result(await call(["pane", "list"]));
  const panes = r?.panes;
  return Array.isArray(panes) ? (panes as PaneInfo[]) : [];
}

export async function currentPane(): Promise<PaneInfo | null> {
  const r = result(await call(["pane", "current"]));
  const pane = r?.pane;
  return pane && typeof pane === "object" ? (pane as PaneInfo) : null;
}

export interface WorkspaceInfo {
  workspace_id?: string | null;
  label?: string;
  focused?: boolean;
  active_tab_id?: string | null;
  worktree?: {
    checkout_path?: string;
    repo_name?: string;
    repo_root?: string;
  } | null;
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  const r = result(await call(["workspace", "list"]));
  const ws = r?.workspaces;
  return Array.isArray(ws) ? (ws as WorkspaceInfo[]) : [];
}

/**
 * No `--ttl-ms`: an expired token leaves the sidebar blank, which reads as
 * "this branch has no PR".
 */
export async function setToken(paneId: string, name: string, value: string): Promise<void> {
  await call([
    "pane", "report-metadata", paneId,
    "--source", METADATA_SOURCE,
    "--token", `${name}=${value}`,
  ]);
}

/**
 * Set the title Herdr paints on the pane header.
 *
 * Use `report-metadata --title`, never `pane rename`: rename rewrites `label`,
 * which `adoptWidget` matches the widget on.
 */
export async function setPaneTitle(paneId: string, title: string): Promise<void> {
  await call([
    "pane", "report-metadata", paneId,
    "--source", METADATA_SOURCE,
    "--title", title,
  ]);
}

export async function clearToken(paneId: string, name: string): Promise<void> {
  await call([
    "pane", "report-metadata", paneId,
    "--source", METADATA_SOURCE,
    "--clear-token", name,
  ]);
}

/**
 * Move a pane and return the id it now has. A cross-tab move renames the pane,
 * and the new id is only in the reply.
 *
 * `ratio` is the share the target keeps, so callers pass `moveRatio(desired)`.
 * `--no-focus` stops the move from interrupting the user and from emitting
 * focus events that re-run follow.
 */
export async function movePane(
  paneId: string,
  target: { tabId?: string; targetPane?: string; split?: "right" | "down"; ratio?: number },
): Promise<string | null> {
  const args = ["pane", "move", paneId, "--no-focus"];
  if (target.tabId) args.push("--tab", target.tabId);
  if (target.targetPane) args.push("--target-pane", target.targetPane);
  if (target.split) args.push("--split", target.split);
  if (target.ratio != null) args.push("--ratio", String(target.ratio));
  const r = result(await call(args));
  const moved = r?.move_result as { pane?: { pane_id?: string } } | undefined;
  return moved?.pane?.pane_id ?? null;
}

export async function openPluginPane(
  entrypoint: string,
  target: { targetPane?: string; direction?: "right" | "down"; ratio?: number },
): Promise<string | null> {
  const args = [
    "plugin", "pane", "open",
    "--plugin", PLUGIN_ID,
    "--entrypoint", entrypoint,
    "--placement", "split",
    "--no-focus",
  ];
  if (target.targetPane) args.push("--target-pane", target.targetPane);
  if (target.direction) args.push("--direction", target.direction);
  const r = result(await call(args));
  // The reply is {plugin_pane: {..., pane: {pane_id}}}. `plugin_pane.pane_id`
  // is undefined, which reads as a failed open and orphans the pane.
  const wrapper = r?.plugin_pane as { pane?: { pane_id?: string } } | undefined;
  return wrapper?.pane?.pane_id ?? null;
}

export async function closePluginPane(paneId: string): Promise<void> {
  await call(["plugin", "pane", "close", paneId]);
}

/**
 * Move a pane's split by a relative amount. The CLI has no command to set an
 * absolute ratio, so this is the only route to a width.
 */
export async function resizePane(
  paneId: string,
  direction: "left" | "right" | "up" | "down",
  amount: number,
): Promise<void> {
  await call([
    "pane", "resize",
    "--pane", paneId,
    "--direction", direction,
    "--amount", String(amount),
  ]);
}

/**
 * Make Herdr apply the current layout to the ptys in a pane's tab.
 *
 * Herdr sizes a tab's ptys when it shows the tab, so the pane beside a newly
 * arrived widget keeps its old size and Herdr clips what it draws. A
 * zero-amount resize moves no split but resyncs the ptys.
 */
export async function resyncPane(paneId: string): Promise<void> {
  await resizePane(paneId, "left", 0);
}

/** Run `follow`, which opens the widget if there is none and is idempotent. */
export async function openWidget(): Promise<number> {
  const root = process.env.HERDR_PLUGIN_ROOT ?? ".";
  const p = Bun.spawn(["bun", `${root}/bin/follow.ts`], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return await p.exited;
}
