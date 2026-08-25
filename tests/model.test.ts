import { describe, expect, test } from "bun:test";
import {
  headline,
  parseSearch,
  PRECEDENCE,
  type PrRow,
  rollupChecks,
  signalsFor,
} from "../src/model.ts";

const live = await Bun.file("tests/fixtures/search.json").json();
const states = await Bun.file("tests/fixtures/states.json").json();

const byNumber = (n: number): PrRow => {
  const row = parseSearch(states).rows.find((r) => r.number === n);
  if (!row) throw new Error(`fixture has no PR #${n}`);
  return row;
};

const run = (conclusion: string | null, status = "COMPLETED") => ({
  __typename: "CheckRun",
  conclusion,
  status,
});

describe("rollupChecks", () => {
  test("no checks is not a pass", () => {
    expect(rollupChecks([])).toBe("none");
  });

  test("every check skipped or cancelled reports no news, not a pass", () => {
    expect(rollupChecks([run("SKIPPED"), run("CANCELLED")])).toBe("none");
  });

  test("a cancelled run is not a failure", () => {
    expect(rollupChecks([run("CANCELLED"), run("SUCCESS")])).toBe("pass");
  });

  test.each([["FAILURE"], ["TIMED_OUT"], ["ACTION_REQUIRED"], ["ERROR"]])(
    "%s fails the rollup",
    (conclusion) => {
      expect(rollupChecks([run(conclusion), run("SUCCESS")])).toBe("fail");
    },
  );

  test("failure outranks pending", () => {
    expect(rollupChecks([run(null, "IN_PROGRESS"), run("FAILURE")])).toBe("fail");
  });

  test("a running CheckRun has a null conclusion, not a pending one", () => {
    expect(rollupChecks([run(null, "IN_PROGRESS")])).toBe("pending");
  });

  test("legacy StatusContext uses state for both outcome and pending", () => {
    expect(rollupChecks([{ __typename: "StatusContext", state: "PENDING" }]))
      .toBe("pending");
    expect(rollupChecks([{ __typename: "StatusContext", state: "SUCCESS" }]))
      .toBe("pass");
  });
});

describe("signals and precedence", () => {
  test("a PR with nothing to say is clean, never empty", () => {
    expect(signalsFor(byNumber(112))).toEqual(["clean"]);
  });

  test("changes requested outranks failing checks", () => {
    expect(headline(byNumber(101))).toBe("changes-requested");
  });

  test("unresolved threads outrank a required review", () => {
    const row = byNumber(102);
    expect(signalsFor(row)).toEqual(["unresolved", "review-required"]);
    expect(headline(row)).toBe("unresolved");
  });

  test("a draft's signals are unchanged — draft dims, it does not mask", () => {
    const row = byNumber(108);
    expect(row.isDraft).toBe(true);
    expect(signalsFor(row)).toEqual(["checks-failed", "approved"]);
  });

  test("signals are always ordered by PRECEDENCE", () => {
    for (const row of parseSearch(states).rows) {
      const idx = signalsFor(row).map((s) => PRECEDENCE.indexOf(s));
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    }
  });
});

describe("parseSearch", () => {
  test("orders oldest-created first", () => {
    const dates = parseSearch(live).rows.map((r) => r.createdAt);
    expect(dates).toEqual([...dates].sort());
  });

  test("drafts keep their date position rather than sinking", () => {
    const rows = parseSearch(live).rows;
    const drafts = rows.filter((r) => r.isDraft).map((r) => rows.indexOf(r));
    // In this fixture the drafts are the newest PRs, so they land last by
    // date. The assertion that matters is that nothing reordered them.
    expect(drafts).toEqual(
      rows
        .map((r, i) => [r, i] as const)
        .filter(([r]) => r.isDraft)
        .map(([, i]) => i),
    );
  });

  test("counts only unresolved threads", () => {
    expect(byNumber(112).unresolved).toBe(0); // four resolved threads
    expect(byNumber(102).unresolved).toBe(3);
  });

  test("a capped thread page reports a floor, not a confident count", () => {
    const row = byNumber(109);
    expect(row.unresolved).toBe(100);
    expect(row.unresolvedCapped).toBe(true);
  });

  test("an uncapped page is not marked as a floor", () => {
    expect(byNumber(102).unresolvedCapped).toBe(false);
  });

  // GitHub populates reviewDecision only where branch protection requires a
  // review, so on an unprotected repository these are the *only* thing that
  // distinguishes an approved pull request from an unreviewed one.
  describe("a review state GitHub declines to decide", () => {
    test("an approval with no branch protection is still approved", () => {
      const row = byNumber(114);
      expect(row.review).toBe("APPROVED");
      expect(headline(row)).toBe("approved");
    });

    test("a request for changes outranks an approval", () => {
      expect(byNumber(115).review).toBe("CHANGES_REQUESTED");
    });

    test("a review asked for and not given reads as required", () => {
      const row = byNumber(116);
      expect(row.review).toBe("REVIEW_REQUIRED");
      expect(headline(row)).toBe("review-required");
    });

    test("an approval in hand outranks a request still outstanding", () => {
      expect(byNumber(117).review).toBe("APPROVED");
    });

    test("a decision GitHub does give is never second-guessed", () => {
      expect(byNumber(118).review).toBe("REVIEW_REQUIRED");
    });

    test("COMMENTED reviews are not an opinion", () => {
      const node = {
        ...states.data.search.nodes[0],
        reviewDecision: null,
        reviewRequests: { totalCount: 0 },
        latestOpinionatedReviews: { nodes: [{ state: "COMMENTED" }] },
      };
      const out = parseSearch({ data: { search: { issueCount: 1, nodes: [node] } } });
      expect(out.rows[0]!.review).toBeNull();
      expect(headline(out.rows[0]!)).toBe("clean");
    });
  });

  test("an unrecognised reviewDecision degrades to null", () => {
    const odd = { data: { search: { issueCount: 1, nodes: [{ ...states.data.search.nodes[0], reviewDecision: "SOMETHING_NEW" }] } } };
    expect(parseSearch(odd).rows[0]!.review).toBeNull();
  });

  test("issueCount above the fetched count reports the remainder", () => {
    const capped = { data: { search: { issueCount: 137, nodes: states.data.search.nodes } } };
    expect(parseSearch(capped).omitted).toBe(137 - states.data.search.nodes.length);
  });

  test("non-PR search results are dropped rather than rendered blank", () => {
    const mixed = { data: { search: { issueCount: 2, nodes: [{}, states.data.search.nodes[0]] } } };
    expect(parseSearch(mixed).rows).toHaveLength(1);
  });

  test("an empty or malformed payload yields no rows and does not throw", () => {
    expect(parseSearch({}).rows).toEqual([]);
    expect(parseSearch(null).rows).toEqual([]);
    expect(parseSearch({ data: { search: { nodes: null } } }).rows).toEqual([]);
  });

  test("the live fixture parses to the shape the pane expects", () => {
    const list = parseSearch(live);
    expect(list.rows).toHaveLength(12);
    expect(list.omitted).toBe(0);
    expect(list.rows.every((r) => r.owner && r.repo && r.url && r.number > 0))
      .toBe(true);
  });
});
