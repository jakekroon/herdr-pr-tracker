import { describe, expect, test } from "bun:test";
import {
  headline,
  INBOUND_PRECEDENCE,
  parseInbound,
  PRECEDENCE,
  type PrRow,
  signalsFor,
} from "../src/model.ts";

const fixture = await Bun.file("tests/fixtures/inbound.json").json();
const list = parseInbound(fixture);
const by = (n: number): PrRow => {
  const row = list.rows.find((r) => r.number === n);
  if (!row) throw new Error(`fixture has no PR #${n}`);
  return row;
};

describe("parseInbound", () => {
  test("collects the union of the three searches once each", () => {
    expect(list.rows.map((r) => r.number).sort()).toEqual([101, 102, 103, 104, 105, 106]);
  });

  test("a pull request in two searches is one row, not two", () => {
    expect(list.rows.filter((r) => r.number === 102)).toHaveLength(1);
    expect(list.rows.filter((r) => r.number === 104)).toHaveLength(1);
  });

  test("reviewer outranks involved when a pull request is in both", () => {
    // #102 is review-requested *and* involved; #104 is reviewed-by and
    // involved. Either way you were asked, which is the stronger claim.
    expect(by(102).reason).toBe("reviewer");
    expect(by(104).reason).toBe("reviewer");
  });

  test("already reviewed is a reviewer reason, not a separate one", () => {
    expect(by(103).reason).toBe("reviewer");
  });

  test("involved-only rows keep the weaker reason", () => {
    expect(by(105).reason).toBe("involved");
  });

  test("orders newest-created first", () => {
    // The inbound list accumulates — it does not empty by being worked — so the
    // oldest rows are the ones already reviewed or merely commented on, and
    // pushing the freshest requests off the bottom is the failure to avoid.
    expect(list.rows.map((r) => r.number)).toEqual([104, 103, 101, 106, 102, 105]);
  });

  test("carries the author, which the inbound identity line needs", () => {
    expect(by(101).author).toBe("priya");
    expect(by(105).author).toBe("wren");
  });

  test("caps the union and reports what it dropped as omitted", () => {
    const capped = parseInbound(fixture, 100, 3);
    expect(capped.rows.map((r) => r.number)).toEqual([104, 103, 101]);
    expect(capped.omitted).toBe(3);
  });

  test("an empty response is an empty list, not a crash", () => {
    expect(parseInbound({}).rows).toEqual([]);
    expect(parseInbound({ data: {} }).rows).toEqual([]);
  });
});

describe("inbound precedence", () => {
  test("a conflict owns an inbound row over the review it was asked for", () => {
    const row = by(106);
    expect(row.conflict).toBe(true);
    expect(row.review).toBe("REVIEW_REQUIRED");
    expect(row.reason).toBe("reviewer");
    // Both signals are still carried — re-ranking hides nothing — but the
    // conflict is the one that colours the row.
    expect(signalsFor(row, "inbound")).toEqual(["conflict", "review-required"]);
    expect(headline(row, "inbound")).toBe("conflict");
  });

  test("ranks the same signals as the authored order, never a different set", () => {
    expect([...INBOUND_PRECEDENCE].sort()).toEqual([...PRECEDENCE].sort());
  });

  test("a conflict leads both orders — not reviewable outranks not reviewed", () => {
    // Why, in CONTEXT.md and docs/adr/0004 — not restated here, where it would
    // be the copy that drifts.
    expect(INBOUND_PRECEDENCE[0]).toBe("conflict");
    expect(PRECEDENCE[0]).toBe("conflict");
  });

  test("review required is loudest of the rest, because it is the point of the view", () => {
    expect(INBOUND_PRECEDENCE[1]).toBe("review-required");
  });

  test("changes requested is quietest, because it is usually your own verdict", () => {
    expect(INBOUND_PRECEDENCE.at(-1)).toBe("changes-requested");
  });

  test("the two orders disagree on a row that carries both kinds of news", () => {
    // #101: review required with failing checks. As the author the red CI is
    // yours to fix; as the reviewer it is theirs, and the ask is yours.
    expect(headline(by(101), "authored")).toBe("checks-failed");
    expect(headline(by(101), "inbound")).toBe("review-required");

    // #102: changes requested, failing checks, unresolved threads.
    expect(headline(by(102), "authored")).toBe("changes-requested");
    expect(headline(by(102), "inbound")).toBe("unresolved");
  });

  test("defaults to the authored order, so existing callers are unchanged", () => {
    expect(headline(by(101))).toBe(headline(by(101), "authored"));
  });

  test("signals are ordered by the view as well", () => {
    expect(signalsFor(by(102), "inbound")[0]).toBe("unresolved");
    expect(signalsFor(by(102), "authored")[0]).toBe("changes-requested");
  });
});
