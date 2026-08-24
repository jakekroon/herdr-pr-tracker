import { describe, expect, test } from "bun:test";
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
