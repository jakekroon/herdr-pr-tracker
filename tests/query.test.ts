import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SEARCH,
  INBOUND_QUERY,
  inboundComplete,
  INBOUND_SEARCHES,
  SEARCH_PAGE,
  SEARCH_QUERY,
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
    // `involves:@me` is author OR assignee OR mentions OR commenter, so without
    // this every authored PR would appear in the inbound view as well.
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
    // Both documents must yield rows parseSearch can read; a field present in
    // one and not the other is a row that renders blank in one view only.
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
    // The failure this exists for: if a reviewer search errors and `involved`
    // succeeds, every surviving row is labelled involved, and `◦` then says
    // "nobody asked you" about pull requests where somebody did.
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
    // The cap belongs to the union: three searches each capped at 20 can
    // between them miss a row that belongs in the top 20 overall.
    expect(SEARCH_PAGE).toBe(100);
  });
});
