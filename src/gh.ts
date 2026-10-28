// The only module that talks to GitHub. Keep the logic in `model.ts` and
// `query.ts`, where the tests reach it.

import { parseInbound, parseSearch, type PrList } from "./model.ts";
import {
  idleSince,
  type IgnoreEntry,
  inboundArgs,
  inboundComplete,
  searchArgs,
} from "./query.ts";

export type GhFailure = "auth" | "network" | "rate" | "other";

export class GhError extends Error {
  constructor(message: string, readonly kind: GhFailure) {
    super(message);
    this.name = "GhError";
  }
}

async function run(
  args: string[],
  cwd?: string,
): Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn(["gh", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // The pane is a tty, so gh would otherwise page and colour its output.
    env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1", CLICOLOR: "0" },
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { ok: code === 0, out, err };
}

/** Map gh's stderr onto the short reason the header shows. */
export function classify(err: string): GhError {
  const e = err.toLowerCase();
  if (
    e.includes("gh auth login") || e.includes("authentication") ||
    e.includes("credentials") || e.includes("bad credentials") ||
    e.includes("401")
  ) return new GhError("auth failed", "auth");
  if (e.includes("rate limit") || e.includes("secondary rate") || e.includes("api rate")) {
    return new GhError("rate limited", "rate");
  }
  if (
    e.includes("dial tcp") || e.includes("no such host") ||
    e.includes("connection refused") || e.includes("network is unreachable") ||
    e.includes("timeout") || e.includes("i/o timeout")
  ) return new GhError("offline", "network");
  if (e.includes("403")) return new GhError("forbidden", "rate");
  const first = err.trim().split("\n")[0] ?? "";
  return new GhError(first ? first.slice(0, 40) : "gh failed", "other");
}

/** `hasData` decides whether a partial answer is usable. */
async function graphql(
  args: string[],
  hasData: (data: Record<string, unknown>) => boolean,
): Promise<unknown> {
  const r = await run(["api", "graphql", ...args]);
  if (!r.ok) throw classify(r.err || r.out);

  let payload: unknown;
  try {
    payload = JSON.parse(r.out);
  } catch {
    throw new GhError("bad response", "other");
  }

  // GraphQL reports failures with HTTP 200 and an `errors` array, so gh exits 0.
  const errors = (payload as { errors?: Array<{ message?: string }> })?.errors;
  const data = (payload as { data?: Record<string, unknown> })?.data ?? {};
  if (Array.isArray(errors) && errors.length > 0 && !hasData(data)) {
    throw classify(errors.map((e) => e?.message ?? "").join(" "));
  }
  return payload;
}

/**
 * `ignore` and `maxIdleDays` have no default, so `tsc` fails a caller that
 * forgets them. `threads` caps `reviewThreads` per PR.
 */
export async function fetchPrs(
  query: string,
  maxPrs: number,
  ignore: readonly IgnoreEntry[],
  maxIdleDays: number | null,
  threads = 100,
): Promise<PrList> {
  const payload = await graphql(
    searchArgs(query, maxPrs, ignore, idleSince(maxIdleDays, new Date()), threads),
    (data) => Boolean(data.search),
  );
  return parseSearch(payload, threads);
}

/** Takes no config query: an override would break the reviewer/involved
 * labels. The ignore list only removes rows, so it applies here too. */
export async function fetchInbound(
  maxPrs: number,
  ignore: readonly IgnoreEntry[],
  maxIdleDays: number | null,
  threads = 100,
): Promise<PrList> {
  const payload = await graphql(
    inboundArgs(ignore, idleSince(maxIdleDays, new Date()), threads),
    inboundComplete,
  );
  return parseInbound(payload, threads, maxPrs);
}

/** The PR for one branch, for the sidebar token. */
export async function fetchBranchPr(
  cwd: string,
  branch: string,
): Promise<{ number: number; state: string; isDraft: boolean } | null> {
  const r = await run(["pr", "view", branch, "--json", "number,state,isDraft"], cwd);
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.out);
    return typeof j?.number === "number"
      ? { number: j.number, state: String(j.state ?? "OPEN"), isDraft: j.isDraft === true }
      : null;
  } catch {
    return null;
  }
}

export async function fetchBranchChecks(cwd: string, branch: string): Promise<string[]> {
  const r = await run(["pr", "checks", branch, "--json", "bucket"], cwd);
  // `gh pr checks` exits non-zero when a check fails, so read the output anyway.
  try {
    const j = JSON.parse(r.out);
    return Array.isArray(j) ? j.map((c: { bucket?: unknown }) => String(c?.bucket ?? "")) : [];
  } catch {
    return [];
  }
}
