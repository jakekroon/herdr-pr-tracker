import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SEARCH,
  INBOUND_QUERY,
  inboundComplete,
  INBOUND_SEARCHES,
  SEARCH_PAGE,
  SEARCH_QUERY,
  idleSince,
  withIgnores,
} from "../src/query.ts";

describe("inbound searches", () => {
  test("are the three GitHub search has no OR for", () => {
    const qs = INBOUND_SEARCHES.map((s) => s.q).join("\n");
    expect(qs).toContain("review-requested:@me");
    expect(qs).toContain("reviewed-by:@me");
    expect(qs).toContain("involves:@me");
    expect(INBOUND_SEARCHES).toHaveLength(3);
  });

  test("map onto two exclusive reasons, requested and reviewed sharing one", () => {
    const reasons = INBOUND_SEARCHES.map((s) => s.reason);
    expect(reasons.filter((r) => r === "reviewer")).toHaveLength(2);
    expect(reasons.filter((r) => r === "involved")).toHaveLength(1);
  });

  test("exclude your own pull requests, so the two views stay disjoint", () => {
    // `involves:@me` includes the author, so authored PRs would show here too.
    for (const s of INBOUND_SEARCHES) expect(s.q).toContain("-author:@me");
  });

  test("keep the archived-repo exclusion the authored search has", () => {
    for (const s of INBOUND_SEARCHES) expect(s.q).toContain("archived:false");
    expect(DEFAULT_SEARCH).toContain("archived:false");
  });

  test("are open pull requests only", () => {
    for (const s of INBOUND_SEARCHES) {
      expect(s.q).toContain("is:pr");
      expect(s.q).toContain("is:open");
    }
  });
});

describe("INBOUND_QUERY", () => {
  test("aliases every declared search, so adding one cannot be half-done", () => {
    for (const s of INBOUND_SEARCHES) {
      expect(INBOUND_QUERY).toContain(`${s.alias}: search(`);
      expect(INBOUND_QUERY).toContain(`$${s.alias}: String!`);
    }
  });

  test("uses distinct aliases", () => {
    const aliases = INBOUND_SEARCHES.map((s) => s.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  test("selects the same pull request fields as the authored search", () => {
    // A field missing from one document renders blank in that view only.
    for (const field of ["headRefName", "reviewDecision", "isDraft", "createdAt"]) {
      expect(SEARCH_QUERY).toContain(field);
      expect(INBOUND_QUERY).toContain(field);
    }
  });

  test("asks for the author, which the inbound identity line needs", () => {
    expect(INBOUND_QUERY).toContain("author");
  });
});

describe("inboundComplete", () => {
  const alias = (reason: string) =>
    INBOUND_SEARCHES.filter((s) => s.reason === reason).map((s) => s.alias);
  const all = Object.fromEntries(INBOUND_SEARCHES.map((s) => [s.alias, {}]));

  test("accepts a response where every search answered", () => {
    expect(inboundComplete(all)).toBe(true);
  });

  test("rejects a response missing a reviewer search", () => {
    // If a reviewer search errors and `involved` succeeds, every row would show
    // `◦` ("nobody asked you") on pull requests where somebody did.
    for (const a of alias("reviewer")) {
      const partial = { ...all };
      delete (partial as Record<string, unknown>)[a];
      expect(inboundComplete(partial)).toBe(false);
    }
  });

  test("tolerates a missing involved search, which only shortens the list", () => {
    const partial = { ...all };
    for (const a of alias("involved")) {
      delete (partial as Record<string, unknown>)[a];
    }
    expect(inboundComplete(partial)).toBe(true);
  });

  test("rejects an empty response", () => {
    expect(inboundComplete({})).toBe(false);
  });
});

describe("paging", () => {
  test("asks each search for a full page, not the configured cap", () => {
    // Three searches capped at 20 each can miss a row from the top 20 overall.
    expect(SEARCH_PAGE).toBe(100);
  });
});

describe("withIgnores", () => {
  const repo = (owner: string, name: string) =>
    ({ kind: "repo", owner, name }) as const;
  const ownerOf = (o: string) => ({ kind: "owner", owner: o }) as const;

  test("a repository becomes a negated repo qualifier", () => {
    expect(withIgnores("Q", [repo("acme", "web-app")]))
      .toBe("Q -repo:acme/web-app");
  });

  test("an owner becomes a negated user qualifier, not org and not owner", () => {
    // `user:` is documented and covers organisations. `owner:` is undocumented.
    expect(withIgnores("Q", [ownerOf("acme")])).toBe("Q -user:acme");
  });

  test("an author becomes a negated author qualifier, verbatim", () => {
    // Verbatim because a bot only matches with its suffix or its app prefix:
    // probed, `-author:dependabot` subtracts nothing.
    expect(withIgnores("Q", [{ kind: "author", login: "renovate[bot]" }]))
      .toBe("Q -author:renovate[bot]");
    expect(withIgnores("Q", [{ kind: "author", login: "app/dependabot" }]))
      .toBe("Q -author:app/dependabot");
  });

  test("every entry is emitted, in order", () => {
    expect(withIgnores("Q", [repo("acme", "web-app"), ownerOf("other")]))
      .toBe("Q -repo:acme/web-app -user:other");
  });

  const entries = [{ kind: "repo", owner: "acme", name: "web-app" }] as const;

  test("an empty list returns the query untouched", () => {
    expect(withIgnores(DEFAULT_SEARCH, [])).toBe(DEFAULT_SEARCH);
  });

  test("appends to the authored search", () => {
    expect(withIgnores(DEFAULT_SEARCH, [...entries]))
      .toBe(`${DEFAULT_SEARCH} -repo:acme/web-app`);
  });

  test("appends to a user-supplied search as readily as to the default", () => {
    // No conflict detection: a contradicted `repo:` yields an empty list.
    expect(withIgnores("is:pr author:@me repo:acme/web-app", [...entries]))
      .toBe("is:pr author:@me repo:acme/web-app -repo:acme/web-app");
  });

  test("reaches every inbound search, so a view cannot forget it", () => {
    for (const s of INBOUND_SEARCHES) {
      expect(withIgnores(s.q, [...entries])).toContain("-repo:acme/web-app");
    }
  });
});

describe("idleSince", () => {
  test("no cutoff configured is no cutoff date", () => {
    expect(idleSince(null, new Date("2026-09-29T12:00:00Z"))).toBeNull();
  });

  test("is the date N days before now", () => {
    expect(idleSince(30, new Date("2026-09-29T12:00:00Z"))).toBe("2026-08-30");
  });

  test("is taken in UTC, whatever the local date is", () => {
    // 23:30 on the 29th in UTC-7 is already the 30th in UTC.
    expect(idleSince(1, new Date("2026-09-29T23:30:00-07:00"))).toBe("2026-09-29");
  });

  test("rolls back across a year boundary", () => {
    expect(idleSince(10, new Date("2027-01-05T00:00:00Z"))).toBe("2026-12-26");
  });
});
