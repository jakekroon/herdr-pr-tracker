import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GLYPHS,
  GLYPH_SETS,
  glyphsFor,
  type Glyphs,
  isGlyphSet,
  marksOf,
} from "../src/glyphs.ts";
import { width } from "../src/render.ts";

/** Nerd Fonts places Octicons at f400–f533. */
const OCTICONS = { first: 0xf400, last: 0xf533 };
/** Upstream Nerd Fonts glyph map at v3.4.0 and v3.5.1. See its `_note`. */
const OCTICONS_UPSTREAM: Record<string, { octicon: string; codepoint: string }> =
  (await Bun.file("tests/fixtures/octicons.json").json()).marks;

const sets = GLYPH_SETS.map((s) => [s, glyphsFor(s)] as const);

describe("glyph sets", () => {
  test("the default is the unicode set, so an unconfigured widget is unchanged", () => {
    expect(DEFAULT_GLYPHS).toBe("unicode");
    expect(glyphsFor()).toBe(glyphsFor("unicode"));
  });

  test("every set answers the same questions", () => {
    const keys = (g: Glyphs) =>
      [...Object.keys(g), ...Object.keys(g.ci).map((k) => `ci.${k}`),
        ...Object.keys(g.review).map((k) => `review.${k}`)].sort();
    const [first, ...rest] = sets.map(([, g]) => keys(g));
    for (const other of rest) expect(other).toEqual(first!);
  });

  // `width()` cannot see these: emoji presentation (`✅` U+2705) makes a terminal
  // spend two columns, and a default-ignorable spends none.
  test("every mark in every set is a single code point", () => {
    for (const [name, g] of sets) {
      for (const [what, mark] of Object.entries(marksOf(g))) {
        expect(`${name}.${what}=${[...mark].length}`).toBe(`${name}.${what}=1`);
      }
    }
  });

  test("no mark asks a terminal for a second column, or for none", () => {
    for (const [name, g] of sets) {
      for (const [what, mark] of Object.entries(marksOf(g))) {
        expect(`${name}.${what} emoji=${/\p{Emoji_Presentation}/u.test(mark)}`)
          .toBe(`${name}.${what} emoji=false`);
        expect(`${name}.${what} ignorable=${/\p{Default_Ignorable_Code_Point}/u.test(mark)}`)
          .toBe(`${name}.${what} ignorable=false`);
      }
    }
  });

  // A mark that matched the SGR or OSC 8 patterns would measure zero.
  test("the renderer's own width() sees every mark", () => {
    for (const [name, g] of sets) {
      for (const [what, mark] of Object.entries(marksOf(g))) {
        expect(`${name}.${what}=${width(mark)}`).toBe(`${name}.${what}=1`);
      }
    }
  });
});

describe("the nerd set", () => {
  const nerd = glyphsFor("nerd");

  test("draws every mark from the Octicons block", () => {
    for (const [what, mark] of Object.entries(marksOf(nerd))) {
      const cp = mark.codePointAt(0)!;
      expect(`${what}=${cp >= OCTICONS.first && cp <= OCTICONS.last}`)
        .toBe(`${what}=true`);
    }
  });

  // The block test passes for any typo inside f400–f533. Regenerate the fixture
  // on a Nerd Fonts bump: Octicons were remapped at 3.0.
  test("every mark is the Octicon its comment names, at both pinned tags", () => {
    const marks = marksOf(nerd);
    expect(Object.keys(marks).sort()).toEqual(Object.keys(OCTICONS_UPSTREAM).sort());
    for (const [what, mark] of Object.entries(marks)) {
      const want = OCTICONS_UPSTREAM[what]!;
      const got = mark.codePointAt(0)!.toString(16);
      expect(`${what} ${want.octicon}=${got}`)
        .toBe(`${what} ${want.octicon}=${want.codepoint}`);
    }
  });

  // The unicode set uses `✓` and `✗` for both review and CI. Octicons has a
  // circled pair for review.
  test("separates a review verdict from a build result", () => {
    expect(nerd.ci.pass).not.toBe(nerd.review.APPROVED);
    expect(nerd.ci.fail).not.toBe(nerd.review.CHANGES_REQUESTED);
  });

  test("no two marks are the same, so no cell is ambiguous", () => {
    const marks = Object.values(marksOf(nerd));
    expect(new Set(marks).size).toBe(marks.length);
  });
});

describe("the unicode set", () => {
  const uni = glyphsFor("unicode");

  test("is unchanged from what the widget has always drawn", () => {
    expect(uni.ci).toEqual({ pass: "✓", fail: "✗", pending: "●" });
    expect(uni.review).toEqual({
      APPROVED: "✓",
      CHANGES_REQUESTED: "✗",
      REVIEW_REQUIRED: "◆",
    });
    expect(uni.conflict).toBe("⊘");
    expect(uni.linked).toBe("▪");
    expect(uni.draft).toBe("◌");
    expect(uni.involved).toBe("◦");
    expect(uni.unresolved).toBe("⚑");
    expect(uni.notice).toBe("⚠");
    expect(uni.refreshing).toBe("⟳");
    expect(uni.clear).toBe("✓");
  });

  test("still spends one glyph on both a build and a review", () => {
    expect(uni.ci.pass).toBe(uni.review.APPROVED);
    expect(uni.ci.fail).toBe(uni.review.CHANGES_REQUESTED);
  });
});

describe("isGlyphSet", () => {
  test("accepts exactly the names the config documents", () => {
    for (const s of GLYPH_SETS) expect(isGlyphSet(s)).toBe(true);
  });

  test("refuses anything else, so a typo falls back rather than throwing", () => {
    for (const bad of ["", "Nerd", "octicons", "ascii", "true", "1"]) {
      expect(isGlyphSet(bad)).toBe(false);
    }
  });
});
