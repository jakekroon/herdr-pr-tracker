// The only module that talks to GitHub. Everything it returns is plain data,
// so the model and render layers stay testable without a network or a token.

import { parseInbound, parseSearch, type PrList } from "./model.ts";
import {
  type IgnoreEntry,
  INBOUND_QUERY,
  inboundComplete,
  INBOUND_SEARCHES,
  SEARCH_PAGE,
  SEARCH_QUERY,
  withIgnores,
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
    // gh reaches for a pager and colours its output when it believes it has a
    // tty. The pane renderer *is* a tty, so say otherwise explicitly.
    env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1", CLICOLOR: "0" },
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { ok: code === 0, out, err };
}

/**
 * Map gh's stderr onto the short reason the header shows.
 *
 * The header has room for a few words, and "offline" versus "auth failed" is
 * the difference between waiting and going to fix something — so the
 * classification is worth getting right even though the text is tiny.
 */
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

/**
 * One GraphQL request, with the error handling both views need.
 *
 * `hasData` decides what counts as a usable answer, which is the only thing
 * that differs between them: the authored view needs its one search, and the
 * inbound view is content with any one of its three — losing a search is a
 * thinner list, not a failed refresh.
 */
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

  // GraphQL reports failures with HTTP 200 and an `errors` array. Partial data
  // alongside errors is still worth rendering; no data at all is a failure.
  const errors = (payload as { errors?: Array<{ message?: string }> })?.errors;
  const data = (payload as { data?: Record<string, unknown> })?.data ?? {};
  if (Array.isArray(errors) && errors.length > 0 && !hasData(data)) {
    throw classify(errors.map((e) => e?.message ?? "").join(" "));
  }
  return payload;
}

/**
 * Fetch every open PR the search matches, in one request.
 *
 * `threads` caps reviewThreads per PR; a PR at the cap reports its unresolved
 * count as a floor rather than a confident number (model.unresolvedCapped).
 *
 * `ignore` is subtracted here rather than by the caller, for the same reason
 * `fetchInbound` subtracts it too: applied at the call sites, a view could be
 * added that forgot to, and the symptom would be a setting that works in one
 * view and not the other. It has no default for the same reason — a required
 * parameter makes tsc the enforcer, which is where this repo puts invariants it
 * does not want to rely on a reader noticing.
 */
export async function fetchPrs(
  query: string,
  maxPrs: number,
  ignore: readonly IgnoreEntry[],
  threads = 100,
): Promise<PrList> {
  const payload = await graphql([
    "-f",
    `query=${SEARCH_QUERY}`,
    "-F",
    `q=${withIgnores(query, ignore)}`,
    "-F",
    `prs=${maxPrs}`,
    "-F",
    `threads=${threads}`,
  ], (data) => Boolean(data.search));
  return parseSearch(payload, threads);
}

/**
 * Fetch the inbound view: the three searches GitHub has no `OR` for, aliased
 * into one document so it is still a single request.
 *
 * Deliberately not parameterised by a config query. The three are load-bearing
 * for the reviewer/involved distinction, and an override would break what the
 * glyph means with no way for the reader to notice.
 *
 * The ignore list is the one exception, and it is not an exception to that rule
 * so much as outside it: it can only remove rows, and no surviving row's reason
 * changes because another row left. See
 * docs/adr/0005-ignore-list-reaches-both-views.md.
 */
export async function fetchInbound(
  maxPrs: number,
  ignore: readonly IgnoreEntry[],
  threads = 100,
): Promise<PrList> {
  const payload = await graphql([
    "-f",
    `query=${INBOUND_QUERY}`,
    ...INBOUND_SEARCHES.flatMap((
      s,
    ) => ["-F", `${s.alias}=${withIgnores(s.q, ignore)}`]),
    "-F",
    // Each search is paged in full and the configured cap is applied to the
    // union afterwards, which is where it belongs: three searches each capped
    // at 20 can between them miss a row that belongs in the top 20 overall.
    `prs=${SEARCH_PAGE}`,
    "-F",
    `threads=${threads}`,
  ], inboundComplete);
  return parseInbound(payload, threads, maxPrs);
}

/**
 * The PR for one branch, for the sidebar token. A separate and much cheaper
 * query than the search: it answers "what is the PR in front of me?".
 */
export async function fetchBranchPr(
  cwd: string,
  branch: string,
): Promise<{ number: number; state: string; isDraft: boolean } | null> {
  const r = await run(["pr", "view", branch, "--json", "number,state,isDraft"], cwd);
  // No PR for this branch is the ordinary case, not an error worth surfacing.
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

/** Check buckets for one branch, reusing gh's own bucketing. */
export async function fetchBranchChecks(cwd: string, branch: string): Promise<string[]> {
  const r = await run(["pr", "checks", branch, "--json", "bucket"], cwd);
  // `gh pr checks` exits non-zero whenever a check is failing, so a non-zero
  // exit with parseable output is still a valid answer.
  try {
    const j = JSON.parse(r.out);
    return Array.isArray(j) ? j.map((c: { bucket?: unknown }) => String(c?.bucket ?? "")) : [];
  } catch {
    return [];
  }
}
