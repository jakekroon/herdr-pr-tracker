// A GitHub GraphQL response in, an ordered list of rows out. No I/O and no
// clock, so the tests exercise every rule offline.

import { INBOUND_SEARCHES, type Reason } from "./query.ts";
import { DEFAULT_VIEW, type View } from "./view.ts";

export type { Reason };

/** `null` means nobody has reviewed and no review is required. */
export type ReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | null;

/** `none` means no check reported a result. */
export type CiState = "pass" | "fail" | "pending" | "none";

/** Draft is absent: it dims the whole row instead of competing for colour. */
export type Signal =
  | "conflict"
  | "changes-requested"
  | "checks-failed"
  | "unresolved"
  | "review-required"
  | "checks-pending"
  | "approved"
  | "clean";

/** Loudest first: a row takes the colour of the first signal it carries.
 * `unresolved` outranks `review-required` because threads are your work and a
 * pending review is someone else's. */
export const PRECEDENCE: Signal[] = [
  "conflict",
  "changes-requested",
  "checks-failed",
  "unresolved",
  "review-required",
  "checks-pending",
  "approved",
  "clean",
];

/**
 * The ranking for pull requests you review. `conflict` still leads, because a
 * conflicting pull request is not reviewable. `changes-requested` is last,
 * because it is usually your own verdict. Failing checks and threads are the
 * author's job.
 *
 * Keep it a permutation of `PRECEDENCE`: both views show every glyph, so the
 * order only picks the colour.
 */
export const INBOUND_PRECEDENCE: Signal[] = [
  "conflict",
  "review-required",
  "checks-pending",
  "clean",
  "unresolved",
  "checks-failed",
  "approved",
  "changes-requested",
];

function order(view: View): Signal[] {
  return view === "inbound" ? INBOUND_PRECEDENCE : PRECEDENCE;
}

export interface PrRow {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  author: string;
  isDraft: boolean;
  createdAt: string;
  review: ReviewDecision;
  ci: CiState;
  conflict: boolean;
  unresolved: number;
  /** `reviewThreads` hit the page cap, so `unresolved` is a floor. */
  unresolvedCapped: boolean;
  /** A Herdr workspace is open on this branch. The linkage pass sets it. */
  linked: boolean;
  /** Inbound view only. */
  reason?: Reason;
}

export interface PrList {
  rows: PrRow[];
  /** PRs matching the search beyond the ones fetched. */
  omitted: number;
}

/** Show the owner prefix only when the rows span more than one owner. */
export function needsOwner(rows: PrRow[]): boolean {
  const owners = new Set(rows.map((r) => r.owner).filter(Boolean));
  return owners.size > 1;
}

// --- check rollup -----------------------------------------------------------

// CANCELLED is not a failure: a newer push or your own hand usually cancelled
// the run, and red for it trains you to ignore red.
const FAILING = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "ERROR"]);
const IGNORED = new Set(["SKIPPED", "NEUTRAL", "CANCELLED", "STALE"]);

interface RawContext {
  __typename?: string;
  conclusion?: string | null;
  status?: string | null;
  state?: string | null;
}

/**
 * Reads `contexts` because `statusCheckRollup.state` folds CANCELLED into
 * FAILURE, which makes the CANCELLED rule impossible.
 */
export function rollupChecks(contexts: RawContext[]): CiState {
  if (contexts.length === 0) return "none";
  let sawFail = false;
  let sawPending = false;
  let sawSignal = false;

  for (const c of contexts) {
    // A running CheckRun has a null conclusion. A StatusContext puts both
    // outcome and pending in `state`.
    const outcome = c.conclusion ?? c.state ?? null;
    const running =
      (c.status != null && c.status !== "COMPLETED") ||
      outcome === "PENDING" ||
      outcome === "EXPECTED" ||
      outcome === null;

    if (running) {
      sawPending = true;
      sawSignal = true;
      continue;
    }
    if (IGNORED.has(outcome)) continue;
    sawSignal = true;
    if (FAILING.has(outcome)) sawFail = true;
  }

  if (sawFail) return "fail";
  if (sawPending) return "pending";
  // Every check skipped or cancelled: nothing reported a pass.
  return sawSignal ? "pass" : "none";
}

// --- signals ----------------------------------------------------------------

/** Loudest first, and never empty: a quiet row carries `clean`. */
export function signalsFor(row: PrRow, view: View = DEFAULT_VIEW): Signal[] {
  const out: Signal[] = [];
  if (row.conflict) out.push("conflict");
  if (row.review === "CHANGES_REQUESTED") out.push("changes-requested");
  if (row.ci === "fail") out.push("checks-failed");
  if (row.unresolved > 0) out.push("unresolved");
  if (row.review === "REVIEW_REQUIRED") out.push("review-required");
  if (row.ci === "pending") out.push("checks-pending");
  if (row.review === "APPROVED") out.push("approved");
  if (out.length === 0) out.push("clean");
  const rank = order(view);
  return out.sort((a, b) => rank.indexOf(a) - rank.indexOf(b));
}

export function headline(row: PrRow, view: View = DEFAULT_VIEW): Signal {
  return signalsFor(row, view)[0]!;
}

// --- parsing ----------------------------------------------------------------

interface RawNode {
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  createdAt?: string;
  mergeable?: string | null;
  headRefName?: string;
  reviewDecision?: string | null;
  reviewRequests?: { totalCount?: number } | null;
  latestOpinionatedReviews?: {
    nodes?: Array<{ state?: string } | null> | null;
  } | null;
  author?: { login?: string } | null;
  repository?: { name?: string; owner?: { login?: string } };
  reviewThreads?: {
    totalCount?: number;
    nodes?: Array<{ isResolved?: boolean } | null> | null;
  };
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: {
          contexts?: { nodes?: RawContext[] | null } | null;
        } | null;
      };
    } | null> | null;
  };
}

const REVIEW_VALUES = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
]);

/**
 * GitHub sets `reviewDecision` only where branch protection requires a review,
 * so an approved pull request on an unprotected repository reports `null`. The
 * fallback reduces `latestOpinionatedReviews` (one per reviewer, `COMMENTED`
 * dropped) with GitHub's own precedence. An approval outranks an open request:
 * without branch protection one approval is enough to merge.
 */
function reviewOf(n: RawNode): ReviewDecision {
  const given = n.reviewDecision;
  if (REVIEW_VALUES.has(given as string)) return given as ReviewDecision;

  const states = (n.latestOpinionatedReviews?.nodes ?? [])
    .map((r) => r?.state);
  if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (states.includes("APPROVED")) return "APPROVED";
  if ((n.reviewRequests?.totalCount ?? 0) > 0) return "REVIEW_REQUIRED";
  return null;
}

function toRow(n: RawNode, threadCap: number): PrRow {
  const threads = n.reviewThreads?.nodes ?? [];
  const unresolved = threads.filter((t) => t && t.isResolved === false).length;
  const total = n.reviewThreads?.totalCount ?? threads.length;
  const contexts =
    n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];

  return {
    owner: n.repository?.owner?.login ?? "",
    repo: n.repository?.name ?? "",
    number: n.number!,
    title: (n.title ?? "").trim(),
    url: n.url ?? "",
    branch: n.headRefName ?? "",
    author: n.author?.login ?? "",
    isDraft: n.isDraft === true,
    createdAt: n.createdAt ?? "",
    review: reviewOf(n),
    ci: rollupChecks(contexts ?? []),
    // GitHub computes `mergeable` lazily. UNKNOWN and a missing field read as
    // no conflict, so a conflict can appear one poll after the row.
    conflict: n.mergeable === "CONFLICTING",
    unresolved,
    unresolvedCapped: total > threadCap && threads.length >= threadCap,
    linked: false,
  };
}

/** `search(type: ISSUE)` also returns issues, which have no `number` here. */
function nodesOf(result: unknown): RawNode[] {
  const nodes = (result as any)?.nodes;
  return Array.isArray(nodes)
    ? nodes.filter((n: RawNode) => n && typeof n.number === "number")
    : [];
}

/**
 * Oldest-created first. An urgency sort would move rows each time CI flips.
 */
export function parseSearch(payload: unknown, threadCap = 100): PrList {
  const search = (payload as any)?.data?.search ?? {};
  const rows = nodesOf(search)
    .map((n) => toRow(n, threadCap))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const issueCount = typeof search.issueCount === "number"
    ? search.issueCount
    : rows.length;

  return { rows, omitted: Math.max(0, issueCount - rows.length) };
}

const key = (r: PrRow) => `${r.owner}/${r.repo}#${r.number}`;

/**
 * Merges the three inbound searches, newest-created first. The searches
 * overlap, so each row keeps its strongest reason. Reviewed pull requests stay
 * until they merge, so oldest-first would push new requests off the bottom.
 */
export function parseInbound(payload: unknown, threadCap = 100, cap = 100): PrList {
  const data = (payload as any)?.data ?? {};
  const seen = new Map<string, PrRow>();

  for (const search of INBOUND_SEARCHES) {
    for (const node of nodesOf(data[search.alias])) {
      const row = { ...toRow(node, threadCap), reason: search.reason };
      // `INBOUND_SEARCHES` is strongest-first, so the first claim wins.
      const id = key(row);
      if (!seen.has(id)) seen.set(id, row);
    }
  }

  const all = [...seen.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rows = all.slice(0, cap);

  // Count only rows seen and dropped. The searches overlap by an unknown
  // amount, so adding their per-search remainders would overcount.
  return { rows, omitted: all.length - rows.length };
}
