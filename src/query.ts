// GraphQL `search` reaches every repository in one request, and only GraphQL
// exposes `reviewThreads.isResolved`. GitHub charges rate limit per `search`
// field, not per pull request.

/** Shared by both documents. `latestOpinionatedReviews` and `reviewRequests`
 * stand in for `reviewDecision`, which is null without branch protection. */
const PR_FIELDS = `
      ... on PullRequest {
        number
        title
        url
        isDraft
        createdAt
        mergeable
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

/** Why a pull request is in the inbound view. A row has one, the strongest. */
export type Reason = "reviewer" | "involved";

export interface InboundSearch {
  /** Both the GraphQL alias and the variable name. */
  alias: string;
  reason: Reason;
  q: string;
}

// `-author:@me` keeps the views disjoint: `involves:@me` includes the author.
// `reviewed-by` exists because `review-requested` stops matching once you
// review, which would drop the pull request the moment you approve it.
const INBOUND_BASE = "is:pr is:open -author:@me archived:false";

export const INBOUND_SEARCHES: InboundSearch[] = [
  { alias: "requested", reason: "reviewer", q: `${INBOUND_BASE} review-requested:@me` },
  { alias: "reviewed", reason: "reviewer", q: `${INBOUND_BASE} reviewed-by:@me` },
  { alias: "involved", reason: "involved", q: `${INBOUND_BASE} involves:@me` },
];

/** GitHub's maximum page. The inbound cap applies to the union, so each
 * search asks for a full page. */
export const SEARCH_PAGE = 100;

/**
 * A row's reason comes from the search that returned it. If a reviewer search
 * fails, its rows arrive through `involved` and carry the wrong label. A
 * missing `involved` result only shortens the list.
 */
export function inboundComplete(data: Record<string, unknown>): boolean {
  return INBOUND_SEARCHES.every((s) =>
    s.reason !== "reviewer" || Boolean(data[s.alias])
  );
}

/** GitHub search has no `OR` between qualifiers, so the inbound view sends
 * three aliased searches in one request. */
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

// `SEARCH_QUERY` overrides the authored view only. An override of the inbound
// searches would break the reviewer/involved labels without a symptom.
export const DEFAULT_SEARCH = "is:pr is:open author:@me archived:false";

// --- ignoring ---------------------------------------------------------------

/** Parsed once, where the config is read. */
export type IgnoreEntry =
  | { kind: "repo"; owner: string; name: string }
  | { kind: "owner"; owner: string }
  | { kind: "author"; login: string };

/** The negated qualifier one entry adds to a search. */
function negation(e: IgnoreEntry): string {
  switch (e.kind) {
    case "repo":
      return `-repo:${e.owner}/${e.name}`;
    case "owner":
      return `-user:${e.owner}`;
    case "author":
      return `-author:${e.login}`;
  }
}

/**
 * Applies to every search in both views: subtraction can only shorten a list,
 * so it cannot mislabel a row.
 *
 * `-user:` covers personal accounts and organisations, and GitHub documents it
 * for issue search. GitHub ignores a malformed qualifier without an error.
 */
export function withIgnores(q: string, entries: readonly IgnoreEntry[]): string {
  return entries.reduce((acc, e) => `${acc} ${negation(e)}`, q);
}

// --- idle cutoff -------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC `YYYY-MM-DD` for `updated:>=`, or `null` for no cutoff. */
export function idleSince(maxIdleDays: number | null, now: Date): string | null {
  if (maxIdleDays == null) return null;
  return new Date(now.getTime() - maxIdleDays * DAY_MS).toISOString().slice(0, 10);
}

export function withIdleCutoff(q: string, since: string | null): string {
  return since == null ? q : `${q} updated:>=${since}`;
}

// --- request arguments -------------------------------------------------------
//
// Built here, not in `gh.ts`, so a test can check that every search carries
// the ignore list.

export function searchArgs(
  query: string,
  maxPrs: number,
  ignore: readonly IgnoreEntry[],
  since: string | null,
  threads: number,
): string[] {
  return [
    "-f",
    `query=${SEARCH_QUERY}`,
    "-F",
    `q=${withIdleCutoff(withIgnores(query, ignore), since)}`,
    "-F",
    `prs=${maxPrs}`,
    "-F",
    `threads=${threads}`,
  ];
}

/** No `maxPrs`: the caller applies the cap to the union. */
export function inboundArgs(
  ignore: readonly IgnoreEntry[],
  since: string | null,
  threads: number,
): string[] {
  return [
    "-f",
    `query=${INBOUND_QUERY}`,
    ...INBOUND_SEARCHES.flatMap((
      s,
    ) => ["-F", `${s.alias}=${withIdleCutoff(withIgnores(s.q, ignore), since)}`]),
    "-F",
    `prs=${SEARCH_PAGE}`,
    "-F",
    `threads=${threads}`,
  ];
}
