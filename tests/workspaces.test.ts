import { describe, expect, test } from "bun:test";
import { needsOwner, parseSearch, type PrRow } from "../src/model.ts";
import { linkRows, parseWorktrees } from "../src/workspaces.ts";

const live = parseSearch(await Bun.file("tests/fixtures/search.json").json()).rows;

// Real output shape from `git -C ~/code/web-app worktree list --porcelain`.
const PORCELAIN = [
  "worktree /Users/j/code/web-app",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/master",
  "",
  "worktree /Users/j/.herdr/worktrees/web-app/ticket-101",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/TICKET-101-4-permissions",
  "",
  "worktree /Users/j/.herdr/worktrees/web-app/detached",
  "HEAD 3333333333333333333333333333333333333333",
  "detached",
  "",
].join("\n");

describe("parseWorktrees", () => {
  test("maps each checkout path to its branch", () => {
    const m = parseWorktrees(PORCELAIN);
    expect(m.get("/Users/j/code/web-app")).toBe("master");
    expect(m.get("/Users/j/.herdr/worktrees/web-app/ticket-101"))
      .toBe("TICKET-101-4-permissions");
  });

  test("keeps the full branch name, which the workspace label loses", () => {
    // Herdr labels that worktree `ticket-101`, which is a lossy slug of
    // `TICKET-101-4-permissions`: lowercased, and cut short of the part that
    // tells the two TICKET-101 branches apart. Matching on labels would
    // mismatch.
    const branch = parseWorktrees(PORCELAIN)
      .get("/Users/j/.herdr/worktrees/web-app/ticket-101")!;
    expect(branch).not.toBe("ticket-101");
    expect(branch.toLowerCase().startsWith("ticket-101")).toBe(true);
    expect(branch.length).toBeGreaterThan("ticket-101".length);
  });

  test("a detached worktree contributes no branch", () => {
    expect(parseWorktrees(PORCELAIN).has("/Users/j/.herdr/worktrees/web-app/detached"))
      .toBe(false);
  });

  test("empty input yields an empty map rather than throwing", () => {
    expect(parseWorktrees("").size).toBe(0);
  });
});

describe("linkRows", () => {
  const rows: PrRow[] = live.slice(0, 3);

  test("marks only the rows whose repo and branch both match", () => {
    const out = linkRows(rows, [
      { repo: rows[1]!.repo, branch: rows[1]!.branch, workspaceId: "w1" },
    ]);
    expect(out.map((r) => r.linked)).toEqual([false, true, false]);
  });

  test("the same branch name in a different repo does not match", () => {
    const out = linkRows(rows, [
      { repo: "some-other-repo", branch: rows[0]!.branch, workspaceId: "w1" },
    ]);
    expect(out.every((r) => !r.linked)).toBe(true);
  });

  test("no open workspaces leaves every row unlinked", () => {
    expect(linkRows(rows, []).every((r) => !r.linked)).toBe(true);
  });

  test("does not mutate the rows it was given", () => {
    linkRows(rows, [{ repo: rows[0]!.repo, branch: rows[0]!.branch, workspaceId: null }]);
    expect(rows[0]!.linked).toBe(false);
  });
});

describe("needsOwner", () => {
  test("one owner across every PR needs no prefix", () => {
    expect(needsOwner(live)).toBe(false);
  });

  test("a second owner makes the prefix necessary", () => {
    expect(needsOwner([...live, { ...live[0]!, owner: "someone-else" }])).toBe(true);
  });

  test("an empty list needs nothing", () => {
    expect(needsOwner([])).toBe(false);
  });
});
