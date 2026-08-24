// The pure layer: a GitHub GraphQL response in, an ordered list of rows out.
// Nothing here touches gh, herdr, the filesystem or the clock, so every rule
// below is exercised offline by tests/model.test.ts.

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
  | "changes-requested"
  | "checks-failed"
  | "unresolved"
  | "review-required"
  | "checks-pending"
  | "approved"
  | "clean";

/** Loudest-first. The headline colour of a row is the first signal it carries.
 * `changes-requested` outranks `checks-failed` because a human asked for
 * changes and CI is a robot; `unresolved` outranks `review-required` because
 * unresolved threads are your work and a pending review is someone else's. */
export const PRECEDENCE: Signal[] = [
  "changes-requested",
  "checks-failed",
  "unresolved",
  "review-required",
  "checks-pending",
  "approved",
  "clean",
];

export interface PrRow {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  isDraft: boolean;
  createdAt: string;
  review: ReviewDecision;
  ci: CiState;
  /** Unresolved review threads. */
  unresolved: number;
  /** True when reviewThreads hit the page cap, so `unresolved` is a floor. */
  unresolvedCapped: boolean;
  /** A Herdr workspace is open on this PR's branch. Filled in later by the
   * workspace linkage pass; false until then. */
  linked: boolean;
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
export function signalsFor(row: PrRow): Signal[] {
  const out: Signal[] = [];
  if (row.review === "CHANGES_REQUESTED") out.push("changes-requested");
  if (row.ci === "fail") out.push("checks-failed");
  if (row.unresolved > 0) out.push("unresolved");
  if (row.review === "REVIEW_REQUIRED") out.push("review-required");
  if (row.ci === "pending") out.push("checks-pending");
  if (row.review === "APPROVED") out.push("approved");
  if (out.length === 0) out.push("clean");
  return out.sort((a, b) => PRECEDENCE.indexOf(a) - PRECEDENCE.indexOf(b));
}

/** The one signal that sets the row's colour. */
export function headline(row: PrRow): Signal {
  return signalsFor(row)[0]!;
}

// --- parsing ----------------------------------------------------------------

interface RawNode {
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  createdAt?: string;
  headRefName?: string;
  reviewDecision?: string | null;
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
 * Turn a `gh api graphql` response into rows, ordered oldest-created first.
 *
 * Order is `createdAt` ascending and nothing else — deliberately not sorted by
 * urgency. Urgency-sorting makes rows jump position whenever CI flips, and a
 * widget that rearranges itself while you glance at it is harder to read than
 * one whose rows never move. Drafts stay in date position for the same reason.
 */
export function parseSearch(payload: unknown, threadCap = 100): PrList {
  const search = (payload as any)?.data?.search ?? {};
  const nodes: RawNode[] = Array.isArray(search.nodes) ? search.nodes : [];

  const rows: PrRow[] = nodes
    // `search(type: ISSUE)` returns issues too; a non-PR node has no number
    // once the inline fragment fails to match, so drop anything shapeless.
    .filter((n) => n && typeof n.number === "number")
    .map((n) => {
      const threads = n.reviewThreads?.nodes ?? [];
      const unresolved = threads.filter((t) => t && t.isResolved === false)
        .length;
      const total = n.reviewThreads?.totalCount ?? threads.length;
      const contexts =
        n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
      const review = n.reviewDecision ?? null;

      return {
        owner: n.repository?.owner?.login ?? "",
        repo: n.repository?.name ?? "",
        number: n.number!,
        title: (n.title ?? "").trim(),
        url: n.url ?? "",
        branch: n.headRefName ?? "",
        isDraft: n.isDraft === true,
        createdAt: n.createdAt ?? "",
        review: (REVIEW_VALUES.has(review as string)
          ? review
          : null) as ReviewDecision,
        ci: rollupChecks(contexts ?? []),
        unresolved,
        // The thread page is capped, so a PR at the cap may have more
        // unresolved threads than we counted. Render that as a floor rather
        // than as a confident number.
        unresolvedCapped: total > threadCap && threads.length >= threadCap,
        linked: false,
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const issueCount = typeof search.issueCount === "number"
    ? search.issueCount
    : rows.length;

  return { rows, omitted: Math.max(0, issueCount - rows.length) };
}
