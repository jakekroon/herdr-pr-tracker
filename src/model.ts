// The pure layer: a GitHub GraphQL response in, an ordered list of rows out.
// Nothing here touches gh, herdr, the filesystem or the clock, so every rule
// below is exercised offline by tests/model.test.ts and tests/inbound.test.ts.

import { INBOUND_SEARCHES, type Reason } from "./query.ts";
import { DEFAULT_VIEW, type View } from "./view.ts";

export type { Reason };

/** A PR's review state. Four-valued, not boolean: `null` means nobody has
 * reviewed and none is required, which is a different thing from a review
 * being required and not yet given. */
export type ReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | null;

/** Collapsed CI state for a PR. `none` means no checks are configured, which
 * is not the same as passing. */
export type CiState = "pass" | "fail" | "pending" | "none";

/** One artifact worth colouring. Draft is deliberately absent: it is a
 * modifier on the whole row, not a signal competing with these. */
export type Signal =
  | "conflict"
  | "changes-requested"
  | "checks-failed"
  | "unresolved"
  | "review-required"
  | "checks-pending"
  | "approved"
  | "clean";

/** Loudest-first. The headline colour of a row is the first signal it carries.
 * `conflict` leads: it is resolved before anything else about the pull request
 * matters, because a review and a green build are both answers to a question
 * the branch cannot yet ask. Below it, `changes-requested` outranks
 * `checks-failed` because a human asked for changes and CI is a robot;
 * `unresolved` outranks `review-required` because unresolved threads are your
 * work and a pending review is someone else's. */
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
 * The same signals ranked for the inbound view, where the work has changed
 * hands. Below the first place it is very nearly the inverse, and deliberately
 * so:
 *
 * - `conflict` leads both orders — the one signal that does. That is the same
 *   rule reaching the same answer twice for different reasons rather than an
 *   exception to it: to the author a conflict is the first thing to fix, and to
 *   a reviewer a conflicting pull request is *not reviewable*, so "do not read
 *   this yet" is the loudest thing the row can say. It is the argument that
 *   puts failing checks near the bottom of this order, arriving at the top
 *   because a conflict is certain where a red build may be flake.
 * - `review-required` is the whole point of the view, so it leads the rest.
 * - `changes-requested` is usually *your own* verdict, already delivered — the
 *   quietest thing an inbound row can say.
 * - failing checks and unresolved threads are the author's job, and a red pull
 *   request is one it is too early to read.
 *
 * It must stay a permutation of PRECEDENCE rather than a different set: every
 * glyph is visible in both views, so re-ranking changes which signal owns the
 * row's colour and hides nothing. tests/inbound.test.ts asserts that.
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
  /** The login that opened the PR. Unused in the authored view — it is you —
   * and the identity line in the inbound view, where it is not. */
  author: string;
  isDraft: boolean;
  createdAt: string;
  review: ReviewDecision;
  ci: CiState;
  /** The head cannot be merged into the base without a manual resolution.
   * GitHub computes mergeability lazily, so `UNKNOWN` — and a response with no
   * `mergeable` at all — is false here: no news, never a claimed conflict and
   * never a claimed mergeable. See docs/adr/0004. */
  conflict: boolean;
  /** Unresolved review threads. */
  unresolved: number;
  /** True when reviewThreads hit the page cap, so `unresolved` is a floor. */
  unresolvedCapped: boolean;
  /** A Herdr workspace is open on this PR's branch. Filled in later by the
   * workspace linkage pass; false until then. */
  linked: boolean;
  /** Why this PR is in the inbound view. Absent in the authored view, where
   * there is only one reason and it is not worth a word. */
  reason?: Reason;
}

export interface PrList {
  rows: PrRow[];
  /** PRs matching the search beyond the ones fetched. */
  omitted: number;
}

/**
 * Whether repo names need their owner to be unambiguous.
 *
 * With every PR under one owner the prefix is 10 wasted columns on every row;
 * the moment a second owner appears, `web-app#83362` alone stops identifying a
 * PR. So the owner earns its space only when there is more than one.
 */
export function needsOwner(rows: PrRow[]): boolean {
  const owners = new Set(rows.map((r) => r.owner).filter(Boolean));
  return owners.size > 1;
}

// --- check rollup -----------------------------------------------------------

// Conclusions that mean a check genuinely failed and wants your attention.
// CANCELLED is absent on purpose: a cancelled run is almost always one you
// stopped or one a newer push superseded, and colouring it red trains you to
// ignore red. TIMED_OUT and ACTION_REQUIRED are real failures.
const FAILING = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "ERROR"]);
// Neither good nor bad news; they carry no signal at all.
const IGNORED = new Set(["SKIPPED", "NEUTRAL", "CANCELLED", "STALE"]);

interface RawContext {
  __typename?: string;
  conclusion?: string | null;
  status?: string | null;
  state?: string | null;
}

/**
 * Collapse per-check results into one state, worst news first.
 *
 * This reads `contexts` rather than `statusCheckRollup.state` because the
 * rollup state only has SUCCESS/FAILURE/PENDING/ERROR/EXPECTED and folds
 * CANCELLED and TIMED_OUT into FAILURE — so the CANCELLED rule above is
 * unimplementable from the rollup alone.
 */
export function rollupChecks(contexts: RawContext[]): CiState {
  if (contexts.length === 0) return "none";
  let sawFail = false;
  let sawPending = false;
  let sawSignal = false;

  for (const c of contexts) {
    // A CheckRun still running has a null conclusion; a StatusContext uses
    // `state` for both outcome and pending. Normalise to one token.
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
  // Every check was skipped/cancelled: there is no news, so say so rather
  // than claiming a pass nothing actually reported.
  return sawSignal ? "pass" : "none";
}

// --- signals ----------------------------------------------------------------

/** Every signal a row carries, loudest first. Never empty: a PR with nothing
 * to say carries `clean`. */
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

/** The one signal that sets the row's colour. Which one that is depends on the
 * view, because "loudest" means "most likely to be your problem" and that is a
 * different ordering depending on whose pull request it is. */
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
 * The review state, from `reviewDecision` where GitHub gives one and derived
 * from the reviews themselves where it does not.
 *
 * GitHub populates `reviewDecision` only where a review is *required* by
 * branch protection, so on an unprotected repository an approved pull request
 * reports `null` — indistinguishable from nobody having looked. That is why
 * nothing was ever green. `latestOpinionatedReviews` is one review per
 * reviewer with `COMMENTED` already dropped, which is exactly the set GitHub
 * itself reduces to a decision, so the fallback agrees with the field it
 * stands in for rather than inventing a second opinion.
 *
 * The order is the same precedence GitHub uses: a request for changes
 * outranks an approval, because it is the one that blocks. An approval then
 * outranks an outstanding review request — without branch protection one
 * approval is enough to merge, so a lingering request for a second reviewer
 * must not hide the approval that already arrived.
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

/** One raw node to one row. Shared by both views so a field can never be read
 * one way in the authored view and another way in the inbound one. */
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
    // Only CONFLICTING is a conflict. MERGEABLE, UNKNOWN and a missing field
    // are all "not conflicting" — the lazily-computed UNKNOWN deliberately
    // reads the same as a clean branch rather than as a warning.
    conflict: n.mergeable === "CONFLICTING",
    unresolved,
    // The thread page is capped, so a PR at the cap may have more unresolved
    // threads than we counted. Render that as a floor rather than as a
    // confident number.
    unresolvedCapped: total > threadCap && threads.length >= threadCap,
    linked: false,
  };
}

/** `search(type: ISSUE)` returns issues too; a non-PR node has no number once
 * the inline fragment fails to match, so drop anything shapeless. */
function nodesOf(result: unknown): RawNode[] {
  const nodes = (result as any)?.nodes;
  return Array.isArray(nodes)
    ? nodes.filter((n: RawNode) => n && typeof n.number === "number")
    : [];
}

/**
 * Turn a `gh api graphql` response into rows, ordered oldest-created first.
 *
 * Order is `createdAt` ascending and nothing else — deliberately not sorted by
 * urgency. Urgency-sorting makes rows jump position whenever CI flips, and a
 * widget that rearranges itself while you glance at it is harder to read than
 * one whose rows never move. Drafts stay in date position for the same reason.
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

/** A pull request is one row wherever it came from. Repository-qualified,
 * because pull request numbers are only unique within a repository. */
const key = (r: PrRow) => `${r.owner}/${r.repo}#${r.number}`;

/**
 * Turn the three aliased inbound searches into one list, ordered newest-created
 * first.
 *
 * The three overlap by construction — `involves:@me` catches anything you have
 * commented on, which includes most things you have reviewed — so the union is
 * deduplicated and each row keeps the *stronger* reason. Being asked outranks
 * merely being in the conversation.
 *
 * Newest-first inverts the authored view because the inbound list does not
 * empty by being worked: folding `reviewed-by` in means a pull request stays
 * until it merges, so the oldest rows are the ones already dealt with and
 * oldest-first would push the freshest requests off the bottom.
 */
export function parseInbound(payload: unknown, threadCap = 100, cap = 100): PrList {
  const data = (payload as any)?.data ?? {};
  const seen = new Map<string, PrRow>();

  for (const search of INBOUND_SEARCHES) {
    for (const node of nodesOf(data[search.alias])) {
      const row = { ...toRow(node, threadCap), reason: search.reason };
      // Reasons are declared strongest-first, so the first search to claim a
      // row keeps it and a later, weaker one cannot demote it.
      const id = key(row);
      if (!seen.has(id)) seen.set(id, row);
    }
  }

  const all = [...seen.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rows = all.slice(0, cap);

  // Only what we saw and dropped is counted. A per-search `first:` truncation
  // is not added in: the three sets overlap by an unknown amount, so summing
  // their remainders would claim pull requests that may not exist. Each search
  // is paged to GitHub's maximum, so that can only bite past a hundred results
  // in one search — and there the union overflows this cap as well, so the
  // marker is never missing, only modest.
  return { rows, omitted: all.length - rows.length };
}
