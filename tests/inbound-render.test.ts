import { describe, expect, test } from "bun:test";
import { parseInbound, type PrRow } from "../src/model.ts";
import {
  compactRow,
  ELLIPSIS,
  header,
  INVOLVED_GLYPH,
  leadWidth,
  render,
  renderRow,
  type RenderOpts,
  repoHeader,
  width,
} from "../src/render.ts";
import { groupRows } from "../src/render.ts";
import { SWITCHER_LABELS, VIEW_TITLE, viewUrl } from "../src/view.ts";

const list = parseInbound(await Bun.file("tests/fixtures/inbound.json").json());
const NOW = Date.parse("2026-08-25T09:00:00Z");

const opts = (over: Partial<RenderOpts> = {}): RenderOpts => ({
  cols: 44,
  rows: 40,
  now: NOW,
  fetchedAt: NOW - 30_000,
  pollSeconds: 60,
  colour: true,
  showOwner: false,
  omitted: 0,
  view: "inbound",
  ...over,
});

const pr = (n: number): PrRow => {
  const row = list.rows.find((r) => r.number === n);
  if (!row) throw new Error(`no PR #${n}`);
  return row;
};

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")
  .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");

/** The header minus its view switcher, so an assertion about what the summary
 * claims reads the summary and not the control beside it. */
const summary = (line: string) =>
  plain(line).replace(/ · (toggle view|toggle|⇄)(?= · |$)/, "");

describe("header", () => {
  test("names the view, because an empty list looks the same in both", () => {
    expect(plain(header(list.rows, opts()))).toContain("inbound");
  });

  test("drops the needs-you count, which is every row here", () => {
    expect(plain(header(list.rows, opts()))).not.toContain("need you");
  });

  test("names the view before the first fetch too", () => {
    // A cold start in the inbound view is otherwise the same picture as one in
    // the authored view.
    expect(summary(header([], opts({ fetchedAt: null })))).toContain("inbound");
    expect(summary(header([], opts({ fetchedAt: null, view: "authored" }))))
      .not.toContain("inbound");
  });

  test("the authored summary is untouched", () => {
    const text = summary(header(list.rows, opts({ view: "authored" })));
    expect(text).toContain("open");
    expect(text).not.toContain("inbound");
  });
});

describe("the view switcher", () => {
  test("says what it does, in both views — the pane title names the view", () => {
    expect(plain(header(list.rows, opts({ cols: 60 })))).toContain(" · toggle view · ");
    expect(plain(header(list.rows, opts({ cols: 60, view: "authored" }))))
      .toContain(" · toggle view · ");
  });

  test("names the two views on the pane title instead", () => {
    // The view is named where it costs no columns the list wants. Herdr paints
    // this on the pane header via `report-metadata --title`.
    expect(VIEW_TITLE.authored).toBe("My PRs");
    expect(VIEW_TITLE.inbound).toBe("Awaiting Review");
  });

  test("sits between what the pane is showing and how old it is", () => {
    // The count says what you are looking at and the age says whether to trust
    // it; the control to change the first belongs next to it, not in front.
    expect(plain(header(list.rows, opts()))).toMatch(/inbound · toggle view · \d+s ago$/);
  });

  test("carries the URL its link handler matches", () => {
    expect(header(list.rows, opts())).toContain(viewUrl("authored"));
    expect(header(list.rows, opts({ view: "authored" }))).toContain(viewUrl("inbound"));
  });

  test("points at a list a plain click can open", () => {
    // The pane acts on the plain click itself, but it cannot guarantee it owns
    // every click on its own links: anywhere the capture does not apply the URL
    // is simply opened, so it has to be somewhere worth landing rather than a
    // private scheme nothing can open.
    for (const view of ["authored", "inbound"] as const) {
      expect(viewUrl(view)).toStartWith("https://github.com/");
    }
  });

  test("shortens before it disappears", () => {
    // A pane too narrow for "toggle view" keeps a control that says less. The
    // labels are offered longest-first, so this is the middle of the ladder.
    const line = plain(header(list.rows, opts({ cols: 34 })));
    expect(line).toContain(" · toggle");
    expect(line).not.toContain("toggle view");
    expect(width(line)).toBeLessThanOrEqual(34);

    // And narrower still, the glyph — a control at every width the pane has.
    const tighter = plain(header(list.rows, opts({ cols: 30 })));
    expect(tighter).toContain(" · ⇄");
    expect(width(tighter)).toBeLessThanOrEqual(30);
  });

  test("is dropped rather than clipping the summary", () => {
    // The summary is what the line exists to say. A pane too narrow to hold
    // even the shortest label loses the control, not the count or the age.
    const narrow = plain(header(list.rows, opts({ cols: 24 })));
    for (const label of SWITCHER_LABELS) expect(narrow).not.toContain(label);
    expect(narrow).toContain("6 inbound");
    expect(narrow).toContain("ago");
    expect(width(narrow)).toBeLessThanOrEqual(24);
  });

  test("never clips its own label, at any width", () => {
    // A label is offered whole or not at all: half a control says nothing.
    for (let cols = 10; cols <= 60; cols++) {
      const line = plain(header(list.rows, opts({ cols })));
      expect(width(line)).toBeLessThanOrEqual(cols);
      const worn = SWITCHER_LABELS.find((l) => line.includes(l));
      if (worn) expect(line).toContain(` · ${worn}`);
    }
  });

  test("is offered before the first fetch, where the timer will be", () => {
    // A cold start has no age for it to sit in front of, so it goes last.
    expect(plain(header([], opts({ cols: 60, fetchedAt: null })))).toEndWith(" · toggle view");
  });
});

describe("the lead", () => {
  test("is one column wider than the authored view", () => {
    expect(leadWidth("inbound")).toBe(leadWidth("authored") + 1);
  });

  test("marks an involved row and leaves a reviewer row silent", () => {
    expect(plain(renderRow(pr(105), opts())[0])).toContain(INVOLVED_GLYPH);
    expect(plain(renderRow(pr(101), opts())[0])).not.toContain(INVOLVED_GLYPH);
  });

  test("never appears in the authored view", () => {
    const line = plain(renderRow({ ...pr(105) }, opts({ view: "authored" }))[0]);
    expect(line).not.toContain(INVOLVED_GLYPH);
  });
});

describe("the identity line", () => {
  test("leads with the author, not the branch", () => {
    const line = plain(renderRow(pr(101), opts())[0]);
    expect(line.trimStart().startsWith("priya")).toBe(true);
  });

  test("keeps the branch when there are columns spare", () => {
    expect(plain(renderRow(pr(101), opts({ cols: 80 }))[0]))
      .toContain("fix/webhook-retry");
  });

  test("sheds the branch before it truncates the author", () => {
    const line = plain(renderRow(pr(101), opts({ cols: 24 }))[0]);
    expect(line).toContain("priya");
    expect(line).not.toContain("fix/webhook-retry");
  });

  test("the authored view still leads with the branch", () => {
    expect(plain(renderRow(pr(101), opts({ view: "authored" }))[0]).trimStart()
      .startsWith("fix/webhook-retry")).toBe(true);
  });
});

describe("bands", () => {
  test("carry no count, because every row in the view needs you", () => {
    const g = groupRows(list.rows)[0]!;
    expect(plain(repoHeader(g, opts())).trimEnd()).not.toMatch(/\d$/);
  });

  test("still end on the same column as the authored view", () => {
    const g = groupRows(list.rows)[0]!;
    expect(width(repoHeader(g, opts()))).toBe(width(repoHeader(g, opts({ view: "authored" }))));
  });
});

describe("overflow", () => {
  test("drops the oldest, which is the bottom of a newest-first list", () => {
    const lines = render(list.rows, opts({ rows: 9 })).map(plain);
    const body = lines.join("\n");
    // #104 is the newest and must survive; #105 is the oldest and must not.
    expect(body).toContain("#104");
    expect(body).not.toContain("#105");
  });

  test("puts the marker last, next to the rows it stands for", () => {
    const lines = render(list.rows, opts({ rows: 9 })).map(plain).filter((l) => l.trim());
    expect(lines.at(-1)).toContain(`${ELLIPSIS} +`);
  });

  test("the authored view still drops from the top and marks it there", () => {
    const lines = render(list.rows, opts({ rows: 9, view: "authored" }))
      .map(plain).filter((l) => l.trim());
    expect(lines[1]).toContain(`${ELLIPSIS} +`);
  });
});

describe("emphasis", () => {
  test("no row is bold, because a list where every row is loud says nothing", () => {
    for (const row of list.rows) {
      expect(renderRow(row, opts())[0]).not.toContain("\x1b[1m");
      expect(compactRow(row, opts())).not.toContain("\x1b[1m");
    }
  });
});

describe("every line is exactly the pane width", () => {
  test.each([24, 32, 44, 80])("at %i columns", (cols) => {
    for (const row of list.rows) {
      expect(width(renderRow(row, opts({ cols }))[0])).toBe(cols);
      expect(width(compactRow(row, opts({ cols })))).toBe(cols);
    }
  });
});
