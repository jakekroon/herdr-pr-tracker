import { describe, expect, test } from "bun:test";
import {
  adoptWidget,
  DEFAULT_WIDTH_RATIO,
  dockTarget,
  type LayoutPane,
  paneRatio,
  lockIsStale,
  moveRatio,
  ratioChanged,
  shouldRecordWidth,
  usableRatio,
  widthStep,
  type WidgetPane,
} from "../src/dock.ts";

const pane = (id: string, x: number, y: number, width: number, height: number): LayoutPane => ({
  pane_id: id,
  rect: { x, y, width, height },
});

describe("dockTarget", () => {
  test("picks the rightmost pane", () => {
    const panes = [pane("a", 0, 0, 100, 50), pane("b", 100, 0, 80, 50)];
    expect(dockTarget(panes, null)?.pane_id).toBe("b");
  });

  test("breaks a tie on the right edge by height", () => {
    // The real shape this guards: a full-height pane above a five-row strip,
    // both flush to the right edge. Docking beside the strip would give the
    // widget five rows.
    const panes = [pane("tall", 36, 1, 209, 49), pane("strip", 36, 50, 209, 7)];
    expect(dockTarget(panes, null)?.pane_id).toBe("tall");
  });

  test("skips a bottom strip that is the rightmost pane outright", () => {
    // The sibling herdr-motivational-pane docks a seven-row strip along the
    // bottom of the right-hand column. With the widget itself excluded, that
    // strip is the rightmost thing in the tab and there is no tie to break —
    // splitting it turned it into a five-column full-height sliver.
    const panes = [pane("work", 36, 1, 155, 56), pane("strip", 196, 50, 54, 7)];
    expect(dockTarget(panes, "widget")?.pane_id).toBe("work");
  });

  test("a tab of nothing but strips still docks somewhere", () => {
    // Docking badly beats not docking at all: the filter must not be able to
    // empty the candidate list.
    const panes = [pane("a", 0, 50, 100, 7), pane("b", 100, 50, 80, 7)];
    expect(dockTarget(panes, null)?.pane_id).toBe("b");
  });

  test("never returns the widget's own pane", () => {
    const panes = [pane("widget", 200, 0, 40, 50), pane("work", 0, 0, 200, 50)];
    expect(dockTarget(panes, "widget")?.pane_id).toBe("work");
  });

  test("a tab containing only the widget has nothing to dock against", () => {
    expect(dockTarget([pane("widget", 0, 0, 100, 50)], "widget")).toBeNull();
  });

  test("an empty layout yields null rather than throwing", () => {
    expect(dockTarget([], null)).toBeNull();
  });
});

describe("paneRatio", () => {
  test("is the pane's share of its containing area", () => {
    expect(paneRatio(46, 209)).toBeCloseTo(0.22, 2);
  });
  test("a zero-width area yields zero rather than Infinity", () => {
    expect(paneRatio(46, 0)).toBe(0);
  });
});

describe("usableRatio", () => {
  test("rounds to what --ratio can express", () => {
    expect(usableRatio(0.2004)).toBe(0.2);
    expect(usableRatio(48 / 209)).toBe(0.23);
  });

  test("the default width is believable", () => {
    expect(usableRatio(DEFAULT_WIDTH_RATIO)).toBe(DEFAULT_WIDTH_RATIO);
  });

  test("rejects rather than clamps a width no user chose", () => {
    // A zoomed pane measures as the whole tab, and a missing area width
    // measures as zero. Clamping either would record it as a preference.
    expect(usableRatio(1)).toBeNull();
    expect(usableRatio(0)).toBeNull();
    expect(usableRatio(0.02)).toBeNull();
    expect(usableRatio(0.8)).toBeNull();
  });

  test("rejects anything that is not a finite number", () => {
    expect(usableRatio(Number.NaN)).toBeNull();
    expect(usableRatio(null)).toBeNull();
    expect(usableRatio("0.2")).toBeNull();
    expect(usableRatio(undefined)).toBeNull();
  });
});

describe("ratioChanged", () => {
  test("a first measurement is always worth recording", () => {
    expect(ratioChanged(0.25, null)).toBe(true);
  });

  test("an unusable measurement never overwrites what is stored", () => {
    expect(ratioChanged(null, 0.25)).toBe(false);
    expect(ratioChanged(null, null)).toBe(false);
  });

  test("re-docking the same width into a differently divided tab is not a resize", () => {
    // 42/209 and 42/210 are the same chosen width landing a fraction of a
    // column apart; recording that would make the width drift on every hop.
    expect(ratioChanged(usableRatio(42 / 209), usableRatio(42 / 210))).toBe(false);
  });

  test("a width the approach cannot reproduce is not remembered", () => {
    // The finest resize step moves several columns, so a two-column difference
    // is below what any later dock could land on. Recording it would store a
    // number that can only be approximated, and the stored value would then
    // creep a column at a time on every hop.
    expect(ratioChanged(usableRatio(44 / 209), usableRatio(42 / 209))).toBe(false);
  });

  test("a dock stopping legitimately short is not mistaken for a drag", () => {
    // The approach stops inside WIDTH_TOLERANCE, so landing at 0.211 while
    // aiming for 0.2 is the widget's own arithmetic, not a user choice.
    expect(ratioChanged(0.211, 0.2)).toBe(false);
  });

  test("a real drag is well clear of the threshold", () => {
    expect(ratioChanged(0.311, 0.2)).toBe(true);
  });

  test("a drag to a clearly different width is recorded", () => {
    expect(ratioChanged(0.35, DEFAULT_WIDTH_RATIO)).toBe(true);
  });
});

describe("adoptWidget", () => {
  const widget = (id: string, tab: string): WidgetPane => ({
    pane_id: id,
    label: "prs",
    tab_id: tab,
  });

  test("nothing to adopt when no pane carries the label", () => {
    expect(adoptWidget([], "prs", "t1")).toBeNull();
    expect(adoptWidget([{ pane_id: "p1", tab_id: "t1" }], "prs", "t1")).toBeNull();
  });

  test("adopts a widget Herdr reopened under a new id", () => {
    // The reload case: the recorded id is a ghost and this is what is on screen.
    expect(adoptWidget([widget("pY", "t1")], "prs", "t1")).toEqual({
      keep: "pY",
      close: [],
    });
  });

  test("keeps the widget in the focused tab and closes the orphan", () => {
    const plan = adoptWidget([widget("pA", "t9"), widget("pB", "t1")], "prs", "t1");
    expect(plan).toEqual({ keep: "pB", close: ["pA"] });
  });

  test("adopts a widget in another tab so it can be moved rather than duplicated", () => {
    expect(adoptWidget([widget("pA", "t9")], "prs", "t1")).toEqual({
      keep: "pA",
      close: [],
    });
  });

  test("never seizes an agent pane that happens to carry the label", () => {
    const panes: WidgetPane[] = [
      { pane_id: "p1", label: "prs", agent: "claude", tab_id: "t1" },
    ];
    expect(adoptWidget(panes, "prs", "t1")).toBeNull();
  });

  test("ignores the sibling plugin's pane, which labels itself", () => {
    const panes: WidgetPane[] = [
      { pane_id: "pQ", label: "YOUR LABOUR HAS PURPOSE", tab_id: "t1" },
    ];
    expect(adoptWidget(panes, "prs", "t1")).toBeNull();
  });

  test("collapses several orphans down to one widget", () => {
    const plan = adoptWidget(
      [widget("pA", "t9"), widget("pB", "t1"), widget("pC", "t8")],
      "prs",
      "t1",
    );
    expect(plan?.keep).toBe("pB");
    expect(plan?.close.sort()).toEqual(["pA", "pC"]);
  });

  test("an unknown focused tab still yields one widget rather than none", () => {
    expect(adoptWidget([widget("pA", "t9")], "prs", undefined)).toEqual({
      keep: "pA",
      close: [],
    });
  });
});

describe("widthStep", () => {
  test("stops once the width is close enough", () => {
    expect(widthStep(0.2, 0.2)).toBeNull();
    expect(widthStep(0.21, 0.2)).toBeNull();
  });

  test("grows a narrow widget by moving the shared edge left", () => {
    expect(widthStep(0.1, 0.3)?.direction).toBe("left");
  });

  test("shrinks a wide widget by moving the shared edge right", () => {
    expect(widthStep(0.5, 0.2)?.direction).toBe("right");
  });

  test("never jumps the whole gap, so a non-linear amount cannot overshoot", () => {
    // A single computed jump is what put the widget at a tenth of the tab after
    // a workspace change; the step is bounded regardless of how far it is.
    expect(widthStep(0.5, 0.2)?.amount).toBeLessThanOrEqual(0.1);
    expect(widthStep(0.9, 0.05)?.amount).toBeLessThanOrEqual(0.1);
  });

  test("steps coarsely while far and finely when close", () => {
    const far = widthStep(0.5, 0.2)!.amount;
    const near = widthStep(0.24, 0.2)!.amount;
    expect(far).toBeGreaterThan(near);
  });

  test("the finest step is no smaller than the tolerance, so it cannot creep forever", () => {
    expect(widthStep(0.235, 0.2)!.amount).toBeGreaterThanOrEqual(0.02);
  });

  test("a stall coarsens the step rather than giving up", () => {
    const settled = widthStep(0.24, 0.2, 0)!.amount;
    const stalled = widthStep(0.24, 0.2, 1)!.amount;
    expect(stalled).toBeGreaterThan(settled);
  });

  test("stalls never coarsen past the largest step", () => {
    expect(widthStep(0.24, 0.2, 9)!.amount).toBe(0.1);
  });

  test("a non-finite width is left alone rather than resized wildly", () => {
    expect(widthStep(Number.NaN, 0.2)).toBeNull();
  });
});

describe("lockIsStale", () => {
  test("a lock just taken is held", () => {
    expect(lockIsStale(1_000_000, 1_000_040)).toBe(false);
  });

  test("a lock older than the lease may be taken over", () => {
    expect(lockIsStale(1_000_000, 1_000_000 + 15_000)).toBe(true);
  });

  test("an unreadable or missing stamp is stale, so a bad file cannot deadlock placement", () => {
    expect(lockIsStale(Number.NaN, 1_000_000)).toBe(true);
  });

  test("a stamp in the future is a clock change, not a live run", () => {
    expect(lockIsStale(2_000_000, 1_000_000)).toBe(true);
  });
});

describe("moveRatio", () => {
  test("hands the target the complement, since that is the share it keeps", () => {
    // Probed: --ratio 0.8 landed the moved widget at 0.201 of a 209-column tab.
    expect(moveRatio(0.2)).toBe(0.8);
    expect(moveRatio(0.3)).toBe(0.7);
  });

  test("the default width maps to the ratio that produced it", () => {
    expect(moveRatio(DEFAULT_WIDTH_RATIO)).toBe(0.8);
  });

  test("never asks for a degenerate split", () => {
    expect(moveRatio(0)).toBeLessThan(1);
    expect(moveRatio(1)).toBeGreaterThan(0);
  });

  test("a non-finite width falls back to the default rather than NaN", () => {
    expect(moveRatio(Number.NaN)).toBe(0.8);
  });
});

describe("shouldRecordWidth", () => {
  test("records a drag away from both the stored and the reached width", () => {
    expect(shouldRecordWidth(0.4, 0.311, 0.258)).toBe(true);
  });

  test("does not record the width a placement fell short at", () => {
    // The measured bug: stored 0.311, the walk could only reach 0.258 because
    // the tab was shared with another plugin's pane, and the next settled run
    // wrote 0.258 back as though the user had chosen it. Each hop then took
    // another bite.
    expect(shouldRecordWidth(0.258, 0.311, 0.258)).toBe(false);
  });

  test("a shortfall inside the epsilon is not recorded either way", () => {
    expect(shouldRecordWidth(0.315, 0.311, 0.315)).toBe(false);
  });

  test("with no placement on record it is the old ratioChanged rule", () => {
    expect(shouldRecordWidth(0.258, 0.311, null)).toBe(true);
    expect(shouldRecordWidth(0.312, 0.311, null)).toBe(false);
  });

  test("an unmeasurable width is never recorded", () => {
    expect(shouldRecordWidth(null, 0.311, 0.258)).toBe(false);
  });

  test("a first measurement with nothing stored is recorded", () => {
    expect(shouldRecordWidth(0.25, null, null)).toBe(true);
  });
});

describe("lockIsStale as the in-flight test", () => {
  test("a lock stamped just now means a placement is walking the pane", () => {
    // What `placementInFlight` leans on: while this is false the settled path
    // must not record, because the width on screen is mid-walk.
    expect(lockIsStale(1_000_000, 1_000_100)).toBe(false);
  });

  test("a lock older than the lease does not hold recording back forever", () => {
    expect(lockIsStale(1_000_000, 1_000_000 + 20_000)).toBe(true);
  });
});
