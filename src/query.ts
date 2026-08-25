// The GitHub queries this plugin makes. `search` is the only way to reach every
// repo in a single request: `gh pr list` is per-repo, and neither it nor
// `gh search prs` can see `reviewThreads.isResolved` at all (REST/search have
// no notion of a resolved thread — it is a GraphQL-only field).
//
// Cost is charged per `search` field rather than per pull request returned, so
// the poll interval is bounded by attention rather than by rate limit. The
// inbound view is three searches and costs proportionally more than the
// authored view's one; both are far inside the 5000/hour budget.

/** The pull request selection, shared by both documents. One definition, so a
 * field cannot end up present in one view and missing in the other — which
 * would render as a row that is blank in the inbound view only.
 *
 * `reviewDecision` alone is not enough, and this is the trap: GitHub only
 * populates it where a review is *required* by branch protection. Probed
 * 2026-08-25 against this account — four open pull requests carrying an
 * `APPROVED` review all reported `reviewDecision: null`, so the whole fleet
 * rendered as `clean` and nothing was ever green. `latestOpinionatedReviews`
 * is the answer: one review per reviewer, `COMMENTED` already excluded (which
 * is the same review GitHub itself ignores when it computes the decision), so
 * `reviewDecision` can be derived wherever GitHub declines to give one.
 * `reviewRequests.totalCount` supplies the other half — a review asked for and
 * not yet given, which is `REVIEW_REQUIRED` without branch protection. */
const PR_FIELDS = `
      ... on PullRequest {
        number
        title
        url
        isDraft
        createdAt
        headRefName
        reviewDecision
        reviewRequests(first: 1) { totalCount }
        latestOpinionatedReviews(first: 20) { nodes { state } }
        author { login }
        repository { name owner { login } }
        reviewThreads(first: $threads) {
          totalCount
          nodes { isResolved }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { conclusion status }
                    ... on StatusContext { state }
                  }
                }
              }
            }
          }
        }
      }`;

/** The authored view: one search, one point. */
export const SEARCH_QUERY = `
query($q: String!, $prs: Int!, $threads: Int!) {
  search(query: $q, type: ISSUE, first: $prs) {
    issueCount
    nodes {${PR_FIELDS}
    }
  }
  rateLimit { cost remaining }
}
`;

/** Why a pull request is in the inbound view. Exclusive: a row has exactly one,
 * the stronger claim winning. See CONTEXT.md. */
export type Reason = "reviewer" | "involved";

export interface InboundSearch {
  /** The GraphQL alias and the variable name — one identifier, so the document
   * and the parser cannot drift apart. */
  alias: string;
  reason: Reason;
  q: string;
}

// `-author:@me` is what keeps the two views disjoint: `involves:@me` is a
// logical OR over author, assignee, mentions and commenter, so without it every
// pull request in the authored view would appear here too.
//
// `review-requested` and `reviewed-by` are two searches for one reason because
// GitHub stops reporting a review request the moment you review. Asking only
// the first would drop a pull request out of the list at the instant you
// approved it, with no way to watch what happened next.
const INBOUND_BASE = "is:pr is:open -author:@me archived:false";

export const INBOUND_SEARCHES: InboundSearch[] = [
  { alias: "requested", reason: "reviewer", q: `${INBOUND_BASE} review-requested:@me` },
  { alias: "reviewed", reason: "reviewer", q: `${INBOUND_BASE} reviewed-by:@me` },
  { alias: "involved", reason: "involved", q: `${INBOUND_BASE} involves:@me` },
];

/** The most a single GitHub search will return. The inbound searches always ask
 * for this rather than for the configured cap, because the cap belongs to the
 * *union*: asking each search for 20 and then taking 20 of the union can miss
 * rows that a fuller page would have contributed. */
export const SEARCH_PAGE = 100;

/**
 * Whether an inbound response can be trusted to label its rows.
 *
 * GraphQL reports failure with HTTP 200 and an `errors` array, and a partial
 * answer is usually still worth rendering. Not here, in one direction: a row's
 * *reason* comes from which search returned it, so if a reviewer search fails
 * and `involved` succeeds, every row it carried is labelled involved — and `◦`
 * then says "nobody asked you" about pull requests where somebody did.
 *
 * Losing `involved` is safe by the same argument: no surviving row is
 * mislabelled, the list is only shorter, which is what the cap already does.
 */
export function inboundComplete(data: Record<string, unknown>): boolean {
  return INBOUND_SEARCHES.every((s) =>
    s.reason !== "reviewer" || Boolean(data[s.alias])
  );
}

/** The inbound view: three aliased searches in one document, so it is still one
 * request. GitHub search has no `OR` between qualifiers, so three searches is
 * the floor rather than a choice. */
export const INBOUND_QUERY = `
query(${INBOUND_SEARCHES.map((s) => `$${s.alias}: String!`).join(", ")}, $prs: Int!, $threads: Int!) {
${
  INBOUND_SEARCHES.map((s) =>
    `  ${s.alias}: search(query: $${s.alias}, type: ISSUE, first: $prs) {
    nodes {${PR_FIELDS}
    }
  }`
  ).join("\n")
}
  rateLimit { cost remaining }
}
`;

// `archived:false` keeps PRs in archived repos out — they cannot be merged and
// are pure noise. Overridable via SEARCH_QUERY in the plugin config, which
// deliberately reaches the authored view only: the inbound queries are
// load-bearing for the reviewer/involved distinction, and a user overriding
// them would break the meaning of the glyph with no way to notice.
export const DEFAULT_SEARCH = "is:pr is:open author:@me archived:false";
