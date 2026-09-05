import { describe, expect, test } from "bun:test";
import { glyphsFor } from "../src/glyphs.ts";
import {
  parsePrNumber,
  refreshingLabel,
  resolvePaneCwd,
  rollupBuckets,
  tokenLabel,
} from "../src/token.ts";

describe("rollupBuckets", () => {
  test("no checks is not a pass", () => {
    expect(rollupBuckets([])).toBe("none");
  });
  test("a cancelled run is not a failure", () => {
    expect(rollupBuckets(["cancel", "pass"])).toBe("pass");
  });
  test("only skipped or cancelled reports no news", () => {
    expect(rollupBuckets(["skipping", "cancel"])).toBe("none");
  });
  test("failure outranks pending", () => {
    expect(rollupBuckets(["pending", "fail"])).toBe("fail");
  });
  test("pending outranks pass", () => {
    expect(rollupBuckets(["pass", "pending"])).toBe("pending");
  });
});

describe("tokenLabel", () => {
  test("uses the same glyphs as the pane", () => {
    expect(tokenLabel({ number: 864, ci: "pass", isDraft: false })).toBe("#864 ✓");
    expect(tokenLabel({ number: 864, ci: "fail", isDraft: false })).toBe("#864 ✗");
    expect(tokenLabel({ number: 864, ci: "pending", isDraft: false })).toBe("#864 ●");
  });
  test("no checks means no glyph, not a claimed pass", () => {
    expect(tokenLabel({ number: 4, ci: "none", isDraft: false })).toBe("#4");
  });
  test("marks a draft", () => {
    expect(tokenLabel({ number: 21288, ci: "pass", isDraft: true })).toBe("◌#21288 ✓");
  });
});

describe("refreshingLabel", () => {
  test("keeps the number and swaps only the glyph", () => {
    expect(refreshingLabel("#864 ✓")).toBe("#864 ⟳");
  });
  test("recovers the number through a draft marker", () => {
    expect(refreshingLabel("◌#864 ✗", true)).toBe("◌#864 ⟳");
  });
  test("no previous label means nothing to keep on screen", () => {
    expect(refreshingLabel(undefined)).toBeNull();
    expect(refreshingLabel("")).toBeNull();
  });
});

describe("parsePrNumber", () => {
  test.each([["#864 ✓", 864], ["◌#21288 ⟳", 21288], ["", null], [undefined, null], ["nope", null]])(
    "parses %p as %p",
    (label, expected) => {
      expect(parsePrNumber(label as string | undefined)).toBe(expected as number | null);
    },
  );
});

describe("resolvePaneCwd", () => {
  test("prefers cwd over a transient foreground sandbox path", () => {
    expect(resolvePaneCwd({ cwd: "/repo", foreground_cwd: "/tmp/sandbox" })).toBe("/repo");
  });
  test("falls back to foreground_cwd", () => {
    expect(resolvePaneCwd({ foreground_cwd: "/repo" })).toBe("/repo");
  });
  test("no directory at all is undefined, not a guess", () => {
    expect(resolvePaneCwd({})).toBeUndefined();
  });
});

describe("the sidebar token follows the configured glyph set", () => {
  const state = { number: 21288, ci: "pass" as const, isDraft: true };

  test("an unset set draws exactly what it always drew", () => {
    expect(tokenLabel(state)).toBe(tokenLabel(state, "unicode"));
    expect(tokenLabel(state)).toBe("◌#21288 ✓");
  });

  test("the nerd set replaces both the draft mark and the build mark", () => {
    const label = tokenLabel(state, "nerd");
    expect(label).toContain("#21288");
    for (const mark of ["◌", "✓"]) expect(label).not.toContain(mark);
    expect(label).toContain(glyphsFor("nerd").draft);
    expect(label).toContain(glyphsFor("nerd").ci.pass);
  });

  test("no checks still spends no columns on a mark", () => {
    for (const set of ["unicode", "nerd"] as const) {
      expect(tokenLabel({ number: 7, ci: "none", isDraft: false }, set)).toBe("#7");
    }
  });

  test("the refreshing label follows the set too", () => {
    expect(refreshingLabel("#21288 ✓")).toBe("#21288 ⟳");
    expect(refreshingLabel("#21288 ✓", false, "nerd"))
      .toBe(`#21288 ${glyphsFor("nerd").refreshing}`);
  });

  // The invariant CLAUDE.md records: the pane and the sidebar are two surfaces
  // showing the same facts, so a set that renamed a mark on one of them would
  // let them disagree about what a glyph means.
  test("draws the same build marks the pane does", () => {
    for (const set of ["unicode", "nerd"] as const) {
      for (const ci of ["pass", "fail", "pending"] as const) {
        expect(tokenLabel({ number: 1, ci, isDraft: false }, set))
          .toBe(`#1 ${glyphsFor(set).ci[ci]}`);
      }
    }
  });
});
