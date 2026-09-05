import { describe, expect, test } from "bun:test";
import {
  DEFAULTS,
  ignoreNotice,
  ignoreWarning,
  parseConfig,
} from "../src/config.ts";

describe("parseConfig", () => {
  test("ignores comments and blank lines", () => {
    expect(parseConfig("# a comment\n\n   \n")).toEqual({});
  });

  test("reads the documented keys", () => {
    expect(parseConfig([
      "POLL_SECONDS=15",
      "MAX_PRS=25",
      "SHOW_OWNER=always",
      "COLOR=off",
      'SEARCH_QUERY="is:pr is:open review-requested:@me"',
      "TOKEN_THROTTLE_SECONDS=0",
      'IGNORE_REPOS="acme/web-app acme/"',
    ].join("\n"))).toEqual({
      pollSeconds: 15,
      maxPrs: 25,
      showOwner: "always",
      colour: false,
      searchQuery: "is:pr is:open review-requested:@me",
      tokenThrottleSeconds: 0,
      ignore: [
        { kind: "repo", owner: "acme", name: "web-app" },
        { kind: "owner", owner: "acme" },
      ],
      ignoreDropped: [],
    });
  });

  test("strips matching quotes but keeps inner spaces", () => {
    expect(parseConfig("SEARCH_QUERY='is:pr author:@me'").searchQuery)
      .toBe("is:pr author:@me");
  });

  test("clamps MAX_PRS to GitHub's search page cap", () => {
    expect(parseConfig("MAX_PRS=500").maxPrs).toBe(100);
  });

  test("rejects a poll interval too short to be sane", () => {
    expect(parseConfig("POLL_SECONDS=1").pollSeconds).toBeUndefined();
  });

  test("a malformed value falls back to the default rather than to zero", () => {
    expect(parseConfig("POLL_SECONDS=soon").pollSeconds).toBeUndefined();
    expect(parseConfig("MAX_PRS=-4").maxPrs).toBeUndefined();
  });

  test("an unknown SHOW_OWNER value is ignored", () => {
    expect(parseConfig("SHOW_OWNER=sometimes").showOwner).toBeUndefined();
  });

  test.each([["0", false], ["off", false], ["false", false], ["no", false], ["on", true], ["1", true]])(
    "COLOR=%s is %p",
    (v, expected) => expect(parseConfig(`COLOR=${v}`).colour).toBe(expected as boolean),
  );

  test("COLOUR is accepted as a spelling of COLOR", () => {
    expect(parseConfig("COLOUR=off").colour).toBe(false);
  });

  test("later lines win, as a config file should", () => {
    expect(parseConfig("POLL_SECONDS=15\nPOLL_SECONDS=45").pollSeconds).toBe(45);
  });

  test("defaults are the values the README documents", () => {
    expect(DEFAULTS.pollSeconds).toBe(60);
    expect(DEFAULTS.maxPrs).toBe(100);
    expect(DEFAULTS.showOwner).toBe("auto");
    expect(DEFAULTS.colour).toBe(true);
    expect(DEFAULTS.ignore).toEqual([]);
    expect(DEFAULTS.ignoreDropped).toEqual([]);
  });
});

describe("IGNORE_REPOS", () => {
  const ignore = (v: string) => parseConfig(`IGNORE_REPOS=${v}`).ignore;
  const dropped = (v: string) => parseConfig(`IGNORE_REPOS=${v}`).ignoreDropped;

  test("an owner/name entry is a repository", () => {
    expect(ignore("acme/web-app")).toEqual([
      { kind: "repo", owner: "acme", name: "web-app" },
    ]);
  });

  test("a trailing slash makes it the whole owner", () => {
    expect(ignore("acme/")).toEqual([{ kind: "owner", owner: "acme" }]);
  });

  test("splits on whitespace and on commas, so neither typing habit fails quietly", () => {
    // Neither character is legal in an owner or a repository name, so accepting
    // both costs no ambiguity.
    const both = ignore('"acme/web-app, acme/platform  acme/"');
    expect(both).toHaveLength(3);
    expect(both?.[2]).toEqual({ kind: "owner", owner: "acme" });
  });

  test("a bare word is dropped, not guessed at", () => {
    // `-repo:web-app` and `-user:web-app` are both accepted by GitHub and both
    // subtract nothing, so a filter that guessed would fail in silence.
    expect(ignore("web-app")).toEqual([]);
    expect(dropped("web-app")).toEqual(["web-app"]);
  });

  test("a URL is rejected rather than stripped down to a repository", () => {
    expect(ignore("https://github.com/acme/web-app")).toEqual([]);
    expect(dropped("https://github.com/acme/web-app")).toEqual([
      "https://github.com/acme/web-app",
    ]);
  });

  test("more than one slash is not a repository", () => {
    expect(ignore("acme/web-app/tree/main")).toEqual([]);
  });

  test("a slash with no owner is dropped", () => {
    expect(ignore("/web-app")).toEqual([]);
    expect(ignore("/")).toEqual([]);
  });

  test("an empty value is no ignores, the same as unset", () => {
    expect(ignore('""')).toEqual([]);
    expect(ignore('"   "')).toEqual([]);
    expect(dropped('"   "')).toEqual([]);
  });

  test("good entries survive alongside bad ones", () => {
    const mixed = parseConfig('IGNORE_REPOS="acme/web-app web-app acme/"');
    expect(mixed.ignore).toHaveLength(2);
    expect(mixed.ignoreDropped).toEqual(["web-app"]);
  });

  test("duplicates collapse, so the query is not padded with repeats", () => {
    expect(ignore('"acme/web-app acme/web-app"')).toHaveLength(1);
  });

  test("case is preserved but does not create a duplicate", () => {
    // GitHub's qualifiers are case-insensitive, so two spellings of one
    // repository are one ignore entry.
    expect(ignore('"acme/web-app ACME/Web-App"')).toHaveLength(1);
  });

  test("unset leaves the key absent rather than empty", () => {
    expect(parseConfig("POLL_SECONDS=60").ignore).toBeUndefined();
  });

  test("an owner cannot start or end with a hyphen", () => {
    // GitHub logins cannot, so `-repo:-acme/x` is certainly not a repository —
    // and GitHub would answer it by subtracting nothing and saying nothing.
    expect(ignore("-acme/web-app")).toEqual([]);
    expect(ignore("acme-/web-app")).toEqual([]);
    expect(dropped("-acme/web-app")).toEqual(["-acme/web-app"]);
  });

  test("an owner longer than GitHub allows is not an owner", () => {
    expect(ignore(`${"a".repeat(40)}/web-app`)).toEqual([]);
    expect(ignore(`${"a".repeat(39)}/web-app`)).toHaveLength(1);
  });

  test("a repository name may begin with a dot, because .github is real", () => {
    expect(ignore("acme/.github")).toEqual([
      { kind: "repo", owner: "acme", name: ".github" },
    ]);
  });

  test("a name that is only dots is not a name", () => {
    expect(ignore("acme/.")).toEqual([]);
    expect(ignore("acme/..")).toEqual([]);
  });

  test("one mistake is reported once, however many times it is made", () => {
    expect(dropped('"web-app web-app WEB-APP"')).toEqual(["web-app"]);
  });
});

describe("ignoreWarning", () => {
  test("says nothing when nothing was refused", () => {
    expect(ignoreWarning([])).toBeNull();
  });

  test("names every refused entry, and the two shapes that would have worked", () => {
    const w = ignoreWarning(["web-app", "https://github.com/acme/web-app"])!;
    expect(w).toContain("web-app");
    expect(w).toContain("https://github.com/acme/web-app");
    expect(w).toContain('"owner/name"');
    expect(w).toContain('"owner/"');
  });

  test("counts, and agrees with itself about the plural", () => {
    expect(ignoreWarning(["a"])).toContain("1 malformed IGNORE_REPOS entry");
    expect(ignoreWarning(["a", "b"])).toContain("2 malformed IGNORE_REPOS entries");
  });
});

describe("ignoreNotice", () => {
  test("says nothing when nothing was refused", () => {
    expect(ignoreNotice([])).toBeNull();
  });

  test("is short enough for a narrow pane, and does not list the entries", () => {
    // The pane has tens of columns, not hundreds. Naming the offending entries
    // is `ignoreWarning`'s job, where there is room for them.
    const n = ignoreNotice(["web-app", "https://github.com/acme/web-app"])!;
    expect(n.length).toBeLessThanOrEqual(28);
    expect(n).not.toContain("web-app");
  });

  test("counts, and agrees with itself about the plural", () => {
    expect(ignoreNotice(["a"])).toBe("1 bad IGNORE_REPOS entry");
    expect(ignoreNotice(["a", "b"])).toBe("2 bad IGNORE_REPOS entries");
  });

  test("agrees with the stderr sentence about the noun", () => {
    // Both docstrings claim the two cannot disagree about whether there is a
    // problem. They share one plural rule to make that true of the wording too.
    for (const n of [1, 2, 3]) {
      const list = Array.from({ length: n }, (_, i) => `bad-${i}`);
      const noun = n === 1 ? "entry" : "entries";
      expect(ignoreNotice(list)).toContain(`${n} bad IGNORE_REPOS ${noun}`);
      expect(ignoreWarning(list)).toContain(`${n} malformed IGNORE_REPOS ${noun}`);
    }
  });
});

describe("GLYPHS", () => {
  test("defaults to the unicode set, so an unconfigured widget is unchanged", () => {
    expect(DEFAULTS.glyphs).toBe("unicode");
  });

  test("reads the documented names", () => {
    expect(parseConfig("GLYPHS=nerd")).toEqual({ glyphs: "nerd" });
    expect(parseConfig("GLYPHS=unicode")).toEqual({ glyphs: "unicode" });
  });

  // The same rule SHOW_OWNER follows: an unrecognised value is left out of the
  // partial entirely, so the default survives rather than being overwritten
  // with something the renderer cannot draw.
  test("refuses a name it does not know rather than guessing", () => {
    for (const bad of ["GLYPHS=octicons", "GLYPHS=Nerd", "GLYPHS=ascii", "GLYPHS="]) {
      expect(parseConfig(bad)).toEqual({});
    }
  });
});
