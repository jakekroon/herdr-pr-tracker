import { describe, expect, test } from "bun:test";
import { parseInbound } from "../src/model.ts";
import { hitAt, hitTargets, render, type RenderOpts, width } from "../src/render.ts";
import { parseMouse } from "../src/mouse.ts";
import { otherView, SWITCHER_LABELS, viewUrl } from "../src/view.ts";

const list = parseInbound(await Bun.file("tests/fixtures/inbound.json").json());
const NOW = Date.parse("2026-08-25T09:00:00Z");
const opts = (over: Partial<RenderOpts> = {}): RenderOpts => ({
  cols: 52,
  rows: 14,
  now: NOW,
  fetchedAt: NOW - 5_000,
  pollSeconds: 60,
  colour: true,
  showOwner: false,
  omitted: 0,
  view: "inbound",
  ...over,
});

const frame = (over: Partial<RenderOpts> = {}) => render(list.rows, opts(over));

describe("parseMouse", () => {
  test("decodes a press and a release", () => {
    const { events } = parseMouse("\x1b[<0;12;3M\x1b[<0;12;3m");
    expect(events.map((e) => [e.button, e.press, e.col, e.row])).toEqual([
      [0, true, 12, 3],
      [0, false, 12, 3],
    ]);
  });

  test("reports the modifier bits separately", () => {
    // 16 is control, 8 is meta. iTerm2 sends a cmd-click as meta.
    const { events } = parseMouse("\x1b[<16;1;1M\x1b[<8;1;1M");
    expect(events[0]?.ctrl).toBe(true);
    expect(events[1]?.alt).toBe(true);
  });

  test("drops motion and wheel reports", () => {
    // Bit 5 is motion, bit 6 the wheel.
    expect(parseMouse("\x1b[<35;4;4M\x1b[<64;4;4M").events).toEqual([]);
  });

  test("holds a report split across two reads", () => {
    const first = parseMouse("\x1b[<0;9");
    expect(first.events).toEqual([]);
    const second = parseMouse(first.rest + ";2M");
    expect(second.events[0]).toMatchObject({ col: 9, row: 2, press: true });
  });

  test("does not accumulate input that is not a report", () => {
    // Typed input is dropped, not buffered without limit.
    expect(parseMouse("hello there").rest).toBe("");
  });
});

describe("hitTargets", () => {
  const plain = (s: string) =>
    s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");

  test("puts every target on the columns its text actually occupies", () => {
    const lines = frame();
    for (const t of hitTargets(lines)) {
      const text = plain(lines[t.row - 1] ?? "");
      expect(text.slice(t.from - 1, t.to).trim().length).toBeGreaterThan(0);
      expect(t.to).toBeLessThanOrEqual(text.length);
    }
  });

  test("finds the switcher on the header line", () => {
    const t = hitTargets(frame());
    const sw = t.find((x) => x.url === viewUrl("authored"));
    expect(sw?.row).toBe(1);
    const label = SWITCHER_LABELS.find((l) => plain(frame()[0] ?? "").includes(l))!;
    expect(sw!.to - sw!.from + 1).toBe(width(label));
  });

  test("finds one target per pull request, and no more", () => {
    const t = hitTargets(frame()).filter((x) => x.url.includes("/pull/"));
    expect(new Set(t.map((x) => x.url)).size).toBe(t.length);
  });

  test("survives the compact layout, where the link moves to the branch", () => {
    // `render` compacts a short pane.
    const t = hitTargets(frame({ rows: 8 }));
    expect(t.some((x) => x.url.includes("/pull/"))).toBe(true);
    expect(t.some((x) => x.url === viewUrl("authored"))).toBe(true);
  });

  test("stops at an OSC 8 whose terminator was cut off", () => {
    // An unclosed link would make the rest of the line open the wrong pull request.
    expect(hitTargets(["ok \x1b]8;;https://example.com/never-closed"])).toEqual([]);
  });

  test("closes an open hyperlink at the end of the line", () => {
    // The opening terminator bounds the link text, so it stays clickable.
    expect(hitTargets(["\x1b]8;;https://example.com\x1b\\text"])).toEqual([
      { row: 1, from: 1, to: 4, url: "https://example.com" },
    ]);
  });
});

describe("hitAt", () => {
  const lines = frame();
  const t = hitTargets(lines);
  const sw = t.find((x) => x.url === viewUrl("authored"))!;

  test("is inclusive at both ends", () => {
    expect(hitAt(t, sw.row, sw.from)?.url).toBe(sw.url);
    expect(hitAt(t, sw.row, sw.to)?.url).toBe(sw.url);
  });

  test("misses the column either side", () => {
    expect(hitAt(t, sw.row, sw.from - 1)).toBeNull();
    expect(hitAt(t, sw.row, sw.to + 1)).toBeNull();
  });

  test("misses a click on empty space", () => {
    expect(hitAt(t, 2, 1)).toBeNull();
  });
});

describe("what a click does", () => {
  // The pane tells the switcher from a pull request by URL alone.
  test("the switcher's URL is the other view's, in both views", () => {
    for (const view of ["authored", "inbound"] as const) {
      const t = hitTargets(frame({ view }));
      const sw = t.find((x) => x.row === 1);
      expect(sw?.url).toBe(viewUrl(otherView(view)));
    }
  });

  test("no pull request's URL can be mistaken for the switcher", () => {
    const urls = hitTargets(frame()).filter((x) => x.row > 1).map((x) => x.url);
    expect(urls).not.toContain(viewUrl("authored"));
    expect(urls).not.toContain(viewUrl("inbound"));
  });
});
