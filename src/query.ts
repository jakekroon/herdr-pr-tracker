// The one GitHub query this plugin makes. `search` is the only way to reach
// every repo in a single request: `gh pr list` is per-repo, and neither it nor
// `gh search prs` can see `reviewThreads.isResolved` at all (REST/search have
// no notion of a resolved thread — it is a GraphQL-only field).
//
// Cost is 1 point of the 5000/hour GraphQL budget regardless of how many PRs
// come back, so the poll interval is bounded by attention, not by rate limit.
export const SEARCH_QUERY = `
query($q: String!, $prs: Int!, $threads: Int!) {
  search(query: $q, type: ISSUE, first: $prs) {
    issueCount
    nodes {
      ... on PullRequest {
        number
        title
        url
        isDraft
        createdAt
        headRefName
        reviewDecision
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
      }
    }
  }
  rateLimit { cost remaining }
}
`;

// `archived:false` keeps PRs in archived repos out — they cannot be merged and
// are pure noise. Overridable via SEARCH_QUERY in the plugin config.
export const DEFAULT_SEARCH = "is:pr is:open author:@me archived:false";
