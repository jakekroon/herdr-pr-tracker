import { describe, expect, test } from "bun:test";
import { glyphsFor, marksOf } from "../src/glyphs.ts";
import { headline, parseSearch, PRECEDENCE, type PrRow } from "../src/model.ts";
import {
  compactAge,
  compactRow,
  ELLIPSIS,
  header,
  LOUD,
  relativeAge,
  render,
  renderRow,
  type RenderOpts,
  repoHeader,
  RULE,
  SPINNER,
  spinner,
  width,
} from "../src/render.ts";

const live = parseSearch(await Bun.file("tests/fixtures/search.json").json());
const states = parseSearch(await Bun.file("tests/fixtures/states.json").json());

/** The set the widget draws when nothing is configured. */
const UNI = glyphsFor("unicode");

const NOW = 1_800_000_000_000;
const opts = (over: Partial<RenderOpts> = {}): RenderOpts => ({
  cols: 44,
  rows: 40,
  now: NOW,
  fetchedAt: NOW - 30_000,
  pollSeconds: 60,
  colour: true,
  showOwner: false,
  omitted: 0,
  ...over,
});

const pr = (n: number): PrRow => {
  const row = states.rows.find((r) => r.number === n);
  if (!row) throw new Error(`no PR #${n}`);
  return row;
};

// Every assertion about layout measures visible columns, so escapes never
// silently pass for content.
const RESET = "\x1b[0m";
// Intensity runs close with normal-intensity, never a full reset: a reset
// would also drop the colour the run sits inside.
const NORMAL = "\x1b[22m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

/** Every intensity terminator inside a dimmed row must re-open dim, or the
 * rest of the line renders at full brightness. */
const dimThroughout = (line: string) =>
  line.startsWith(DIM) && line.endsWith(NORMAL) &&
  line.slice(DIM.length, -NORMAL.length).split(NORMAL).slice(1)
    .every((seg) => seg === "" || seg.startsWith(DIM));

const plain = (s: string) => s.replace(/\x1b\[\d+m/g, "");

const prAge = (row: PrRow) => compactAge(NOW - Date.parse(row.createdAt));

const vis = (s: string) => width(s);

// A heading is a name, a dim rule out to the right edge and, when the group
// has PRs needing you, a count; comparisons care about the name.
const headingName = (s: string) =>
  s.replace(/\x1b\[\d+m/g, "").replace(new RegExp(` ${RULE}+.*$`), "");

describe("width", () => {
  test("ignores colour escapes", () => {
    expect(width("\x1b[31mred\x1b[39m")).toBe(3);
  });
  test("ignores OSC 8 hyperlink wrappers", () => {
    expect(width("\x1b]8;;https://example.com/x\x1b\\text\x1b]8;;\x1b\\")).toBe(4);
  });
  test("counts a code point once, not its UTF-16 units", () => {
    expect(width("ab🎉")).toBe(3);
  });
});

describe("renderRow", () => {
  test("line one is exactly the pane width", () => {
    for (const cols of [30, 44, 60, 100]) {
      for (const row of [...states.rows, ...live.rows]) {
        expect(vis(renderRow(row, opts({ cols }))[0])).toBe(cols);
      }
    }
  });

  test("a conflict gets its own reserved column in the cluster", () => {
    // The cell is reserved on every row, conflicted or not, so the cluster
    // still aligns down the pane — the same rule the band's count cell
    // follows. A conflicted row spends it; every other row leaves it blank.
    const conflicted = plain(renderRow(pr(119), opts())[0]);
    const clean = plain(renderRow(pr(112), opts())[0]);
    expect(conflicted).toContain(UNI.conflict);
    expect(clean).not.toContain(UNI.conflict);
    // Mergeability GitHub has not computed yet paints nothing at all — the
    // no-news case has to be silent on the *line*, not merely false in the row.
    expect(plain(renderRow(pr(122), opts())[0])).not.toContain(UNI.conflict);
    expect(plain(renderRow(pr(123), opts())[0])).not.toContain(UNI.conflict);
    expect(vis(renderRow(pr(119), opts())[0])).toBe(44);
    // Same right edge, so the reserved cell is what pays for the glyph rather
    // than the cluster growing on the rows that carry one.
    expect(conflicted.length - conflicted.trimEnd().length)
      .toBe(clean.length - clean.trimEnd().length);
  });

  test("the cluster's glyphs are evenly separated, conflict included", () => {
    // Every cell is one column with one column between it and its neighbour,
    // so a row carrying all of them reads as spaced cells rather than as a
    // run of glyphs jammed together. #121 conflicts, has changes requested and
    // is failing, so it is the row that carries the most at once.
    const line = plain(renderRow(pr(121), opts())[0]);
    const cluster = line.slice(-9);
    // conflict, separator, review, separator, the four-wide flag cell (empty
    // here), then CI on the pane edge.
    expect(cluster).toBe("⊘ ✗     ✗");
  });

  test("LOUD is a prefix of PRECEDENCE, or the needs-you count is wrong", () => {
    // `header` and `repoHeader` both count from a row's *headline*, which is
    // only equivalent to "carries a loud signal" while the loud signals are the
    // top of the precedence order. Re-rank one without the other and the counts
    // go quietly wrong, which is the kind of bug this widget has no symptom for.
    expect(LOUD).toEqual(PRECEDENCE.slice(0, LOUD.length));
  });

  test("a conflict is bold in the authored view, like the other loud signals", () => {
    expect(LOUD).toContain("conflict");
    const line = renderRow(pr(119), opts())[0];
    expect(line).toContain(BOLD);
  });

  test("a conflicting draft stays dim throughout, glyph included", () => {
    // Bold is suppressed on a draft — the row is already dim, and bold inside
    // dim renders inconsistently — so the conflict shows without it.
    const line = renderRow(pr(120), opts())[0];
    expect(dimThroughout(line)).toBe(true);
    expect(plain(line)).toContain(UNI.conflict);
    expect(line).not.toContain(BOLD);
  });

  test("line two never exceeds the pane width", () => {
    for (const cols of [20, 30, 44, 80]) {
      for (const row of states.rows) {
        expect(vis(renderRow(row, opts({ cols }))[1])).toBeLessThanOrEqual(cols);
      }
    }
  });

  test("the status cluster survives a branch too long to fit", () => {
    const row = { ...pr(113), branch: "a-very-long-branch-name-indeed" };
    const [line] = renderRow(row, opts({ cols: 24 }));
    expect(vis(line)).toBe(24);
    // The glyph cluster is what must not be truncated: the branch gives up
    // columns first, so the trailing check glyph is still present.
    expect(line).toContain("✓");
    expect(line).toContain(ELLIPSIS);
  });

  test("a draft carries the draft glyph and dims the whole row", () => {
    const [l1, l2] = renderRow(pr(108), opts());
    expect(l1).toContain(UNI.draft);
    expect(l1.startsWith("\x1b[2m")).toBe(true);
    expect(l2.startsWith("\x1b[2m")).toBe(true);
  });

  test("a dimmed draft stays dim past every inner escape", () => {
    // A draft's own dim run wraps a line that already contains one — the age
    // stamp's. SGR intensity has no pop, so the inner terminator would end the
    // row's dim early and leave everything after it bright.
    for (const [l1, l2] of [renderRow(pr(108), opts())]) {
      expect(dimThroughout(l1!)).toBe(true);
      expect(dimThroughout(l2!)).toBe(true);
    }
  });

  test("a dimmed draft still shows its failing check in red", () => {
    const [l1] = renderRow(pr(108), opts());
    expect(l1).toContain("\x1b[31m✗");
  });

  test("a workspace-linked row is marked, an unlinked one is not", () => {
    const linked = renderRow({ ...pr(100), linked: true }, opts())[0];
    const plain = renderRow({ ...pr(100), linked: false }, opts())[0];
    expect(linked).toContain(UNI.linked);
    expect(plain).not.toContain(UNI.linked);
    // Both start names on the same column.
    expect(vis(linked)).toBe(vis(plain));
  });

  test("the title is an OSC 8 hyperlink to the PR", () => {
    const [, l2] = renderRow(pr(100), opts());
    expect(l2).toContain(`\x1b]8;;${pr(100).url}\x1b\\`);
    // The hyperlink closes before the age stamp: the stamp is not part of the
    // clickable region, and an unclosed OSC 8 would swallow the rest of the
    // pane into the link.
    expect(l2).toContain("\x1b]8;;\x1b\\");
    expect(l2.endsWith(NORMAL)).toBe(true);
  });

  test("a capped thread count renders as a floor", () => {
    expect(renderRow(pr(109), opts())[0]).toContain("⚑99+");
  });

  test("a clean row leaves its branch uncoloured — the glyphs may still speak", () => {
    const [l1] = renderRow(pr(112), opts());
    // The branch must not be wrapped in a colour run. A passing check is still
    // allowed its green glyph: "clean" means the row is silent, not blank.
    expect(l1).toMatch(/(?<!\x1b\[\d+m)b112/);
    expect(l1).toContain("\x1b[32m✓");
  });

  test.each([
    [100, "\x1b[32m"], // approved  -> green
    [101, "\x1b[31m"], // changes requested -> red
    [102, "\x1b[33m"], // unresolved -> yellow
    [103, "\x1b[34m"], // pending -> blue
    [106, "\x1b[31m"], // timed out -> red
  ])("PR #%i paints its name with the headline colour", (n, code) => {
    expect(renderRow(pr(n as number), opts())[0]).toContain(code as string);
  });

  test("review required alone is magenta", () => {
    const row = { ...pr(102), unresolved: 0, unresolvedCapped: false };
    expect(renderRow(row, opts())[0]).toContain("\x1b[35m");
  });

  test("colour: false emits no escapes at all on line one", () => {
    for (const row of states.rows) {
      expect(renderRow(row, opts({ colour: false }))[0]).not.toContain("\x1b");
    }
  });

  test("line two ends with how old the PR itself is", () => {
    const row = { ...pr(100), createdAt: new Date(NOW - 86_400_000 * 3).toISOString() };
    const [, l2] = renderRow(row, opts({ cols: 60 }));
    expect(l2.replace(/\x1b\[\d+m/g, "")).toMatch(/3d$/);
  });

  test("a pane too narrow to hold both drops the age, not the title", () => {
    const row = { ...pr(100), createdAt: new Date(NOW - 86_400_000 * 3).toISOString() };
    const [, l2] = renderRow(row, opts({ cols: 18 }));
    expect(l2).not.toMatch(/3d\s*$/);
    expect(vis(l2!)).toBeLessThanOrEqual(18);
  });

  test("an unparseable creation date simply has no age", () => {
    const [, l2] = renderRow({ ...pr(100), createdAt: "" }, opts({ cols: 60 }));
    expect(l2!.endsWith("\x1b]8;;\x1b\\")).toBe(true);
  });

  test.each([
    [101, true], // changes requested
    [102, true], // unresolved threads
    [100, false], // approved
    [112, false], // clean
  ])("PR #%i takes bold only when the signal is loud", (n, bold) => {
    expect(renderRow(pr(n as number), opts())[0]!.includes("\x1b[1m")).toBe(bold);
  });

  test("a draft is dim rather than bold, even when it is failing", () => {
    const [l1] = renderRow(pr(108), opts());
    expect(l1).not.toContain("\x1b[1m");
    expect(l1).toContain("\x1b[31m✗");
  });

  test("line one carries the branch, and line two the number and title", () => {
    const [l1, l2] = renderRow(pr(100), opts({ cols: 60 }));
    expect(l1).toContain(pr(100).branch);
    expect(l1).not.toContain("repo");
    expect(l1).not.toContain("#100");
    expect(l2).toContain(`#100 ${pr(100).title}`.slice(0, 20));
  });
});

describe("header", () => {
  test("reports the age of the data on screen", () => {
    expect(header(live.rows, opts({ fetchedAt: NOW - 125_000 }))).toContain("2m ago");
  });

  test("counts the open PRs, and the ones that are yours to act on", () => {
    const h = header(states.rows, opts({ cols: 60 }));
    const loud = states.rows.filter((r) =>
      r.conflict || r.review === "CHANGES_REQUESTED" || r.ci === "fail" ||
      r.unresolved > 0
    ).length;
    expect(h).toContain(`${states.rows.length} open`);
    expect(h).toContain(`${loud} need you`);
  });

  test("the fetch cap is counted as open, not silently dropped", () => {
    expect(header(live.rows, opts({ cols: 60, omitted: 8 })))
      .toContain(`${live.rows.length + 8} open`);
  });

  test("a list with nothing to act on says only how many are open", () => {
    const calm = live.rows.filter((r) =>
      r.review !== "CHANGES_REQUESTED" && r.ci !== "fail" && r.unresolved === 0
    );
    expect(header(calm, opts({ cols: 60 }))).not.toContain("need you");
  });

  test("goes yellow once the data is older than two poll intervals", () => {
    expect(header(live.rows, opts({ fetchedAt: NOW - 121_000 }))).toContain("\x1b[33m");
    expect(header(live.rows, opts({ fetchedAt: NOW - 119_000 }))).not.toContain("\x1b[33m");
  });

  test("a failed refresh goes red, says why, and still admits the age", () => {
    const h = header(live.rows, opts({ cols: 80, fetchedAt: NOW - 300_000, error: "auth failed" }));
    expect(h).toContain("\x1b[31m");
    expect(h).toContain("auth failed");
    expect(h).toContain("5m ago");
  });

  test("never exceeds the pane width", () => {
    for (const cols of [20, 30, 44, 80]) {
      expect(vis(header(live.rows, opts({ cols, error: "a long failure message" }))))
        .toBeLessThanOrEqual(cols);
    }
  });

  test("before any successful fetch it says loading, not zero PRs", () => {
    const h = header([], opts({ fetchedAt: null }));
    expect(h).toContain("loading");
    expect(h).not.toContain("0 open");
  });

  test("a cold start does not claim the list is clear", () => {
    // Empty before the first fetch means "nothing asked yet", not "nothing
    // open": the pane says only that it is loading.
    const out = render([], opts({ fetchedAt: null }));
    expect(out.join("\n")).not.toContain("all clear");
    expect(out.join("\n")).toContain("loading");
  });

  test("the loading line spins, so a cold start is not mistaken for a hang", () => {
    expect(header([], opts({ fetchedAt: null }))).toContain(spinner(NOW));
    // One frame per second, matching the pane's repaint cadence.
    expect(spinner(NOW)).toBe(spinner(NOW + 999));
    expect(spinner(NOW)).not.toBe(spinner(NOW + 1000));
    expect(spinner(NOW)).toBe(spinner(NOW + 1000 * SPINNER.length));
  });

  test("a failed cold start says why instead of spinning", () => {
    const h = header([], opts({ fetchedAt: null, error: "auth failed" }));
    expect(h).toContain("auth failed");
    expect(h).not.toContain(spinner(NOW));
  });

  test.each([[0, "0s"], [60_000, "1m"], [3_600_000, "1h"], [86_400_000 * 3, "3d"]])(
    "compactAge(%i) is %s",
    (ms, expected) => expect(compactAge(ms as number)).toBe(expected as string),
  );

  test.each([[0, "0s ago"], [59_000, "59s ago"], [60_000, "1m ago"], [3_600_000, "1h ago"], [86_400_000 * 3, "3d ago"]])(
    "relativeAge(%i) is %s",
    (ms, expected) => expect(relativeAge(ms as number)).toBe(expected as string),
  );
});

describe("render", () => {
  test("an empty list says so rather than rendering a blank pane", () => {
    const out = render([], opts());
    expect(out).toHaveLength(3);
    // The header already carries `0 open`; this line says the other half.
    expect(out[0]).toContain("0 open");
    expect(out[1]).toBe("");
    expect(out[2]).toContain("all clear");
    // The commonest good state gets a mark of its own, so it does not read
    // like the blank pane of a widget that has died.
    expect(out[2]).toContain("\x1b[32m✓");
  });

  test("never emits more lines than the pane has rows", () => {
    for (const rows of [1, 2, 3, 5, 11, 26, 40]) {
      expect(render(live.rows, opts({ rows })).length).toBeLessThanOrEqual(rows);
    }
  });

  test("a heading per repo plus two lines per PR when everything fits", () => {
    // Three repositories across the twelve PRs, with a blank line between
    // each pair of groups.
    // Header, the blank line under it, three headings, twenty-four row lines
    // and two blank lines between groups.
    expect(render(live.rows, opts({ rows: 40 })))
      .toHaveLength(1 + 1 + 3 + 12 * 2 + 2);
  });

  test("groups are separated by one blank line, and never led by one", () => {
    const out = render(live.rows, opts({ rows: 40 }));
    // Two separators between three groups, plus the one under the header.
    expect(out.filter((l) => l === "")).toHaveLength(3);
    expect(out[1]).toBe("");
    expect(out[2]).not.toBe("");
  });

  test("a repository heading is carried to the right edge by a dim rule", () => {
    for (const cols of [30, 44, 80]) {
      const out = render(live.rows, opts({ rows: 40, cols }));
      const heading = out.find((l) => l.includes("web-app"))!;
      expect(vis(heading)).toBe(cols);
      expect(heading).toContain(RULE);
      expect(heading.startsWith("\x1b[2m")).toBe(true);
    }
  });

  test("every PR of a repo sits under one heading, in date order", () => {
    const out = render(live.rows, opts({ rows: 60, cols: 60 })).join("\n");
    const headings = out.split("\n").filter((l) => /^\x1b\[2m\S/.test(l));
    expect(headings.map(headingName)).toEqual([
      "platform-infra-tools",
      "web-app",
      "metrics-service",
    ]);
    // web-app's six PRs are contiguous, though they are not contiguous by date.
    expect(out.indexOf("TICKET-102"))
      .toBeLessThan(out.indexOf("metrics-service"));
  });

  test("a band carries the count of its PRs that need you", () => {
    const loud = states.rows.filter((r) => LOUD.includes(headline(r)));
    const calm = states.rows.find((r) => !LOUD.includes(headline(r)))!;
    expect(loud.length).toBeGreaterThan(1);

    const band = repoHeader(
      { owner: "acme", repo: "web-app", rows: [...loud.slice(0, 2), calm] },
      opts(),
    );
    expect(vis(band)).toBe(44);
    expect(headingName(band)).toBe("web-app");
    expect(plain(band).endsWith(" 2")).toBe(true);

    // A group with nothing to act on stays a label: no count at all.
    const quiet = repoHeader({ owner: "acme", repo: "web-app", rows: [calm] }, opts());
    expect(vis(quiet)).toBe(44);
    expect(/\d$/.test(plain(quiet))).toBe(false);
  });

  test("a band too narrow for a rule drops the count before the name", () => {
    const loud = states.rows.filter((r) => LOUD.includes(headline(r)));
    const band = repoHeader(
      { owner: "acme", repo: "web-app", rows: loud },
      opts({ cols: 8 }),
    );
    expect(vis(band)).toBeLessThanOrEqual(8);
    expect(plain(band)).toContain("web");
  });

  test("showOwner puts the owner in front of the repo heading", () => {
    const out = render(live.rows, opts({ rows: 60, showOwner: true })).join("\n");
    expect(out).toContain("acme/web-app");
  });

  test("a pane too short for two-line rows halves them before dropping any", () => {
    // Twelve PRs across three repositories: 1 header + 1 blank + 3 headings
    // + 2 blanks + 12 branch lines = 19 lines, and every PR survives.
    const out = render(live.rows, opts({ rows: 19 }));
    for (const row of live.rows) expect(out.join("\n")).toContain(row.branch);
    expect(out.join("\n")).not.toContain("older");
    // A compact row keeps its link, and its number moves onto the branch line.
    const line = out.find((l) => l.includes(live.rows[0]!.branch))!;
    expect(line).toContain(`\x1b]8;;${live.rows[0]!.url}\x1b\\`);
    expect(line).toContain(`#${live.rows[0]!.number}`);
    expect(vis(line)).toBe(44);
  });

  test("compact rows are exactly the pane width at every size", () => {
    for (const cols of [20, 30, 44, 100]) {
      for (const row of [...states.rows, ...live.rows]) {
        expect(vis(compactRow(row, opts({ cols })))).toBe(cols);
      }
    }
  });

  test("a compact row keeps its signals and drops nothing but the title", () => {
    const line = compactRow(pr(109), opts({ cols: 44 }));
    // #109 is the capped-thread PR: the cluster must survive intact.
    expect(line).toContain("⚑99+");
    expect(line).toContain(pr(109).branch);
    expect(line).toContain(`\x1b]8;;${pr(109).url}\x1b\\`);
  });

  test("a compact row keeps the age compaction used to lose", () => {
    // The list is ordered oldest-first so that "how long has this been
    // sitting" is answerable; dropping the title must not drop the answer.
    const row = live.rows[0]!;
    const line = compactRow(row, opts({ cols: 80 }));
    expect(vis(line)).toBe(80);
    expect(plain(line)).toContain(`#${row.number} ${prAge(row)}`);
  });

  test("a narrowing compact row sheds the age, then the number, never the branch", () => {
    const row = live.rows[0]!;
    const room = (cols: number) => plain(compactRow(row, opts({ cols })));
    const widths = Array.from({ length: 70 }, (_, i) => i + 20);

    // The number appears at a width the age still cannot afford, and the
    // branch is on screen at every width including the narrowest.
    const withNumber = widths.find((c) => room(c).includes(`#${row.number}`))!;
    const withAge = widths.find((c) => room(c).includes(prAge(row)))!;
    expect(room(withNumber)).not.toContain(prAge(row));
    expect(withAge).toBeGreaterThan(withNumber);
    // Six characters, not eight: the conflict cell and its separator are
    // reserved on every row, so at the narrowest width the branch has two
    // columns less to spend than it did before that cell existed. That is the
    // cost the reserved cell was accepted at, and this is where it shows.
    for (const cols of [20, withNumber, withAge, 80]) {
      expect(room(cols)).toContain(row.branch.slice(0, 6));
    }
  });

  test("a compact draft is dim across the whole line, cluster included", () => {
    expect(dimThroughout(compactRow(pr(108), opts()))).toBe(true);
  });

  test("a compact row too narrow for the number keeps the branch", () => {
    const line = compactRow(pr(109), opts({ cols: 19 }));
    expect(vis(line)).toBe(19);
    expect(line).not.toContain("#109");
  });

  test("overflow drops the oldest and keeps the newest", () => {
    const out = render(live.rows, opts({ rows: 11 }));
    const newest = live.rows[live.rows.length - 1]!;
    const oldest = live.rows[0]!;
    expect(out.join("\n")).toContain(newest.branch);
    expect(out.join("\n")).not.toContain(oldest.branch);
  });

  test("overflow announces how many it dropped, on the first row", () => {
    const out = render(live.rows, opts({ rows: 11 }));
    // The blank line under the header costs an eleven-row pane one more PR.
    expect(out[2]).toContain(`${ELLIPSIS} +7 older`);
  });

  test("PRs beyond the fetch cap are added to the dropped count", () => {
    const out = render(live.rows, opts({ rows: 11, omitted: 37 }));
    expect(out[2]).toContain(`+${7 + 37} older`);
  });

  test("a fetch cap alone is announced even when everything on hand fits", () => {
    const out = render(live.rows, opts({ rows: 40, omitted: 37 }));
    expect(out[2]).toContain("+37 older");
  });

  test("a pane one row tall shows the header and nothing else", () => {
    expect(render(live.rows, opts({ rows: 1 }))).toHaveLength(1);
  });
});

describe("notice", () => {
  const NOTICE = "2 bad IGNORE_REPOS entries";

  test("sits on the last line, under the final repository", () => {
    const out = render(live.rows, opts({ rows: 40, notice: NOTICE }));
    expect(out.at(-1)).toContain(NOTICE);
    // Under the list, not inside it: the line above is still a pull request.
    expect(out.at(-2)).not.toContain(NOTICE);
  });

  test("is marked and coloured as attention, not as failure", () => {
    // A refused config entry is not a broken widget: the list above it is
    // correct, and there is something to go and fix.
    const out = render(live.rows, opts({ rows: 40, notice: NOTICE }));
    expect(out.at(-1)).toContain("\x1b[33m⚠");
  });

  test("no notice leaves the pane exactly as it was", () => {
    expect(render(live.rows, opts({ rows: 40 })))
      .toEqual(render(live.rows, opts({ rows: 40, notice: null })));
  });

  test("appears under `all clear` when the list is empty", () => {
    // The case an ignore list makes likeliest: everything ignored, and the one
    // thing worth saying is that some of the ignoring did not parse.
    const out = render([], opts({ notice: NOTICE }));
    expect(out.at(-1)).toContain(NOTICE);
    expect(out.at(-2)).toContain("all clear");
  });

  test("costs a pull request rather than being clipped away", () => {
    // A row that is not on screen is counted by `+N older`; a notice that is
    // not on screen is the bug this line exists to fix.
    const rows = 12;
    const with_ = render(live.rows, opts({ rows, notice: NOTICE }));
    const without = render(live.rows, opts({ rows }));
    expect(with_.at(-1)).toContain(NOTICE);
    expect(with_.length).toBeLessThanOrEqual(rows);
    expect(with_.filter((l) => l.includes("older")).length).toBe(1);
    expect(without.length).toBeLessThanOrEqual(rows);
  });

  test("never pushes the pane over its row budget", () => {
    for (const rows of [1, 2, 3, 4, 5, 11, 26, 40]) {
      expect(render(live.rows, opts({ rows, notice: NOTICE })).length)
        .toBeLessThanOrEqual(rows);
    }
  });

  test("survives every pane tall enough to hold a second line", () => {
    // The budget assertion above passes whether the notice is on screen or
    // clipped away, because `render` ends in a slice — so on its own it reads
    // as a guard for the reservation while measuring something else entirely.
    // This is the half that has to be checked directly: the marker used to
    // escape the reservation at `keep === 0` and the slice trimmed the notice
    // instead of it, silently, in every pane of three rows or fewer.
    for (const rows of [2, 3, 4, 5, 11, 26, 40]) {
      const out = render(live.rows, opts({ rows, notice: NOTICE }));
      expect(out.some((l) => l.includes("IGNORE_REPOS"))).toBe(true);
      expect(out.length).toBeLessThanOrEqual(rows);
    }
  });

  test("yields to the header alone in a one-row pane", () => {
    // The one pane where losing it is right: the header carries the count, the
    // age and the switcher, and a notice in its place would cost all three.
    const out = render(live.rows, opts({ rows: 1, notice: NOTICE }));
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("IGNORE_REPOS");
  });

  test("the `+N older` marker gives up its line before the notice does", () => {
    // Both want the last line of a very short pane. The marker restates what
    // the header already counts; the notice is the only place its fact appears.
    const out = render(live.rows, opts({ rows: 3, notice: NOTICE }));
    expect(out.at(-1)).toContain(NOTICE);
    expect(out.some((l) => l.includes("older"))).toBe(false);
  });

  test("an empty list keeps the notice too", () => {
    for (const rows of [2, 3, 4, 40]) {
      const out = render([], opts({ rows, notice: NOTICE }));
      expect(out.some((l) => l.includes("IGNORE_REPOS"))).toBe(true);
      expect(out.length).toBeLessThanOrEqual(rows);
    }
  });

  test("leaves a column spare, because the glyph may render wide", () => {
    // U+26A0 is East-Asian Ambiguous: `width()` counts it as one column and a
    // terminal set to render ambiguous glyphs wide makes it two. On the last
    // line of the pane that difference wraps the frame a row over budget.
    for (const cols of [12, 20, 40, 80]) {
      const out = render(live.rows, opts({ rows: 40, cols, notice: NOTICE }));
      expect(width(out.at(-1)!)).toBeLessThanOrEqual(cols - 1);
    }
  });

  test("is dropped rather than shown as a bare ellipsis", () => {
    // Clipped to a column or two the notice becomes `…`, which reads as a
    // truncated pull request. Nothing is better than a glyph that misleads.
    for (const cols of [1, 4, 8, 10]) {
      const out = render(live.rows, opts({ rows: 40, cols, notice: NOTICE }));
      expect(out.some((l) => l.includes("\u26a0"))).toBe(false);
    }
  });

  test("is clipped to the pane width like every other line", () => {
    const out = render(live.rows, opts({ rows: 40, cols: 14, notice: NOTICE }));
    expect(width(out.at(-1)!)).toBeLessThanOrEqual(14);
  });
});

describe("glyph sets in the pane", () => {
  // Every mark the *lead* and the cluster's fixed cells can draw at once.
  // Built rather than taken from a fixture: no real pull request carries all of
  // them, and this asserts arithmetic rather than precedence.
  //
  // It cannot carry them all even so — `review` and `ci` are one value each, so
  // a single row leaves four marks unrendered. The width test below loops over
  // both cells for that reason; a mark that only ever appears on a row nothing
  // measures is a mark whose width is untested.
  const loaded: PrRow = {
    owner: "acme",
    repo: "web-app",
    number: 21288,
    title: "Every mark at once",
    url: "https://github.com/acme/web-app/pull/21288",
    branch: "feature/every-mark",
    author: "someone",
    isDraft: true,
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    review: "CHANGES_REQUESTED",
    ci: "fail",
    conflict: true,
    unresolved: 3,
    unresolvedCapped: false,
    linked: true,
    reason: "involved",
  };

  const SETS = ["unicode", "nerd"] as const;

  const REVIEWS = [null, "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] as const;
  const CIS = ["none", "pass", "fail", "pending"] as const;

  test("a fully loaded row still lands exactly on the pane width, whichever mark it carries", () => {
    for (const glyphs of SETS) {
      for (const view of ["authored", "inbound"] as const) {
        for (const cols of [28, 44, 80]) {
          for (const review of REVIEWS) {
            for (const ci of CIS) {
              const row = { ...loaded, review, ci };
              const [line1] = renderRow(row, opts({ cols, view, glyphs }));
              const where = `${glyphs}/${view}/${cols}/${review}/${ci}`;
              expect(`${where}=${width(line1)}`).toBe(`${where}=${cols}`);
            }
          }
        }
      }
    }
  });

  // Every mark the set has, actually painted by the renderer. Without this the
  // review and CI marks the loaded row cannot carry — and the all-clear mark,
  // which only an *empty* pane draws — were reachable only through `glyphsFor`,
  // which is the module under test rather than the surface that uses it.
  test("every mark in the set reaches the pane", () => {
    for (const glyphs of SETS) {
      const g = glyphsFor(glyphs);
      const painted = new Set<string>();
      for (const review of REVIEWS) {
        for (const ci of CIS) {
          for (const view of ["authored", "inbound"] as const) {
            for (const l of renderRow({ ...loaded, review, ci }, opts({ cols: 80, view, glyphs }))) {
              for (const ch of plain(l)) painted.add(ch);
            }
          }
        }
      }
      for (const l of render([], opts({ rows: 10, glyphs, fetchedAt: NOW, notice: "x" }))) {
        for (const ch of plain(l)) painted.add(ch);
      }
      for (const [what, mark] of Object.entries(marksOf(g))) {
        // The sidebar owns `refreshing`; the pane never draws it.
        if (what === "refreshing") continue;
        expect(`${glyphs}.${what} painted=${painted.has(mark)}`)
          .toBe(`${glyphs}.${what} painted=true`);
      }
    }
  });

  test("the all-clear mark comes from the set", () => {
    const empty = (glyphs: "unicode" | "nerd") =>
      render([], opts({ rows: 10, glyphs, fetchedAt: NOW })).map(plain).join("\n");
    expect(empty("unicode")).toContain(`${glyphsFor("unicode").clear} all clear`);
    expect(empty("nerd")).toContain(`${glyphsFor("nerd").clear} all clear`);
    expect(empty("nerd")).not.toContain(glyphsFor("unicode").clear);
  });

  test("the cluster costs the same columns in either set", () => {
    // If the two sets cost different widths, the branch name they leave room
    // for differs — which is the symptom a width regression actually shows.
    for (const view of ["authored", "inbound"] as const) {
      const [a] = renderRow(loaded, opts({ cols: 30, view, glyphs: "unicode" }));
      const [b] = renderRow(loaded, opts({ cols: 30, view, glyphs: "nerd" }));
      const branchOf = (l: string) => /feature\/[a-z-]*/.exec(l)?.[0] ?? "";
      expect(branchOf(b)).toBe(branchOf(a));
    }
  });

  test("the nerd set actually replaces the marks", () => {
    const [uni] = renderRow(loaded, opts({ view: "inbound", glyphs: "unicode" }));
    const [nerd] = renderRow(loaded, opts({ view: "inbound", glyphs: "nerd" }));
    for (const mark of ["⊘", "✗", "⚑", "▪", "◌", "◦"]) {
      expect(`unicode has ${mark}: ${uni.includes(mark)}`)
        .toBe(`unicode has ${mark}: true`);
      expect(`nerd has ${mark}: ${nerd.includes(mark)}`)
        .toBe(`nerd has ${mark}: false`);
    }
  });

  test("an unset glyph option draws exactly what it always drew", () => {
    expect(renderRow(loaded, opts({ view: "inbound" })))
      .toEqual(renderRow(loaded, opts({ view: "inbound", glyphs: "unicode" })));
  });

  test("the notice takes its warning mark from the set", () => {
    const note = "2 bad IGNORE_REPOS entries";
    const out = render(live.rows, opts({ rows: 40, notice: note, glyphs: "nerd" }));
    expect(out.some((l) => l.includes(glyphsFor("unicode").notice))).toBe(false);
    expect(out.some((l) => l.includes(glyphsFor("nerd").notice))).toBe(true);
  });

  test("the whole pane stays inside its width in either set", () => {
    for (const glyphs of SETS) {
      for (const cols of [20, 30, 44, 80]) {
        for (const line of render(live.rows, opts({ rows: 40, cols, glyphs }))) {
          expect(`${glyphs}/${cols}: ${width(line)} <= ${cols}`)
            .toBe(`${glyphs}/${cols}: ${Math.min(width(line), cols)} <= ${cols}`);
        }
      }
    }
  });
});
