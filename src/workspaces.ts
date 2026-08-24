// Which PRs you already have a Herdr workspace open on. This is the one thing
// the widget knows that GitHub's own PR list cannot tell you.

import type { PrRow } from "./model.ts";

export interface OpenBranch {
  repo: string;
  branch: string;
  workspaceId: string | null;
}

/**
 * Mark rows whose branch is checked out in an open Herdr workspace.
 *
 * Matching is on (repo, exact branch). Herdr's workspace *label* is a slug of
 * the branch — `TICKET-101-4-permissions` becomes `ticket-101` — and that
 * transform is lossy, so matching on labels would both miss and mismatch.
 * The branch is read from git instead; see collectOpenBranches.
 */
export function linkRows(rows: PrRow[], open: OpenBranch[]): PrRow[] {
  const key = (repo: string, branch: string) => `${repo} ${branch}`;
  const seen = new Set(open.map((o) => key(o.repo, o.branch)));
  return rows.map((r) => ({ ...r, linked: seen.has(key(r.repo, r.branch)) }));
}

/** Parse `git worktree list --porcelain` into checkout path -> branch. */
export function parseWorktrees(porcelain: string): Map<string, string> {
  const out = new Map<string, string>();
  let path: string | null = null;
  for (const line of porcelain.split("\n")) {
    const l = line.trimEnd();
    if (l.startsWith("worktree ")) path = l.slice("worktree ".length).trim();
    else if (l.startsWith("branch ") && path) {
      // `branch refs/heads/TICKET-100`
      out.set(path, l.slice("branch refs/heads/".length).trim());
    } else if (l === "") path = null;
  }
  return out;
}

interface HerdrWorkspace {
  workspace_id?: string | null;
  worktree?: { checkout_path?: string; repo_name?: string; repo_root?: string } | null;
}

/**
 * Resolve every open Herdr workspace to (repo, branch).
 *
 * One `git worktree list` per distinct repo root rather than one `rev-parse`
 * per workspace: the porcelain listing already carries the branch for every
 * worktree of that repo, so nine workspaces across three repos cost three
 * calls instead of nine.
 */
export async function collectOpenBranches(
  workspaces: HerdrWorkspace[],
): Promise<OpenBranch[]> {
  const roots = new Map<string, string>(); // repo_root -> repo_name
  for (const w of workspaces) {
    const wt = w.worktree;
    if (wt?.repo_root && wt.repo_name) roots.set(wt.repo_root, wt.repo_name);
  }

  const branchByPath = new Map<string, string>();
  await Promise.all(
    [...roots.keys()].map(async (root) => {
      const p = Bun.spawn(["git", "-C", root, "worktree", "list", "--porcelain"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      if (code !== 0) return;
      for (const [path, branch] of parseWorktrees(out)) branchByPath.set(path, branch);
    }),
  );

  const out: OpenBranch[] = [];
  for (const w of workspaces) {
    const wt = w.worktree;
    if (!wt?.checkout_path || !wt.repo_name) continue;
    const branch = branchByPath.get(wt.checkout_path);
    // A detached HEAD has no branch line in the porcelain output, so it simply
    // never matches a PR — which is correct, not a gap.
    if (!branch) continue;
    out.push({ repo: wt.repo_name, branch, workspaceId: w.workspace_id ?? null });
  }
  return out;
}
