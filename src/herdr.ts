// The only module that talks to Herdr. Every call is best-effort: this is a
// widget, and a widget that crashes the pane because a socket call blipped is
// worse than one that draws a slightly stale frame.

const HERDR = process.env.HERDR_BIN_PATH ?? "herdr";

/** The plugin id Herdr launched us as, or the manifest's id for a hand-run. */
export const PLUGIN_ID = process.env.HERDR_PLUGIN_ID ?? "herdr-pr-tracker";

/** Metadata source id. Herdr scopes tokens to a source so two plugins writing
 * the same token name cannot silently overwrite each other. */
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
  /** Herdr's label for the pane. For a plugin pane this is the manifest's
   * `[[panes]].title`, which is how `adoptWidget` recognises the widget. */
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
 * Write a sidebar token for a pane.
 *
 * `--ttl-ms` is deliberately not used: a token that expires leaves the sidebar
 * blank between refreshes, which reads as "this branch has no PR" rather than
 * "nobody has looked recently".
 */
export async function setToken(paneId: string, name: string, value: string): Promise<void> {
  await call([
    "pane", "report-metadata", paneId,
    "--source", METADATA_SOURCE,
    "--token", `${name}=${value}`,
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
 * Move the widget pane under a target pane, returning the id it now wears.
 *
 * Relocating keeps the renderer process alive — the list stays on screen through
 * the move instead of blanking and refetching — but **a cross-tab move renames
 * the pane**, and the new id is only in the reply
 * (`move_result.pane.pane_id`). Reading it is what stops the caller having to
 * guess which pane the widget became.
 *
 * `ratio` is the share the *target* keeps, so callers pass `moveRatio(desired)`.
 * `--no-focus` matters: the widget is a widget, and a relocation that steals
 * focus both interrupts the user and emits the focus events that re-run follow.
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
  // The id is nested two deep: {plugin_pane: {plugin_id, entrypoint, pane: {
  // pane_id, ...}}}. Reading `plugin_pane.pane_id` yields undefined, which
  // looks exactly like a failed open while the pane is in fact on screen —
  // which orphans it, because nothing records its id.
  const wrapper = r?.plugin_pane as { pane?: { pane_id?: string } } | undefined;
  return wrapper?.pane?.pane_id ?? null;
}

export async function closePluginPane(paneId: string): Promise<void> {
  await call(["plugin", "pane", "close", paneId]);
}

/**
 * Widen or narrow the widget's split.
 *
 * `plugin pane open` takes no `--ratio`, and there is **no `herdr layout` CLI
 * subcommand** — the socket API has `layout.set_split_ratio` but the binary
 * exposes no command for it. `pane resize` is the only CLI route, and it moves
 * a split by a relative amount rather than setting an absolute ratio, so the
 * widget aims for its width by moving the edge once on open and then leaves it
 * alone. Best-effort: an unsized pane is still a usable pane.
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
 * Converge on having a widget on screen.
 *
 * `follow` is the single place that knows where the widget belongs and is
 * idempotent — it opens one if there is none and early-exits if there is — so
 * every entrypoint that owes the user a visible pane goes through here rather
 * than reimplementing the spawn.
 */
export async function openWidget(): Promise<number> {
  const root = process.env.HERDR_PLUGIN_ROOT ?? ".";
  const p = Bun.spawn(["bun", `${root}/bin/follow.ts`], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return await p.exited;
}
