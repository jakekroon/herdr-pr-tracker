import { describe, expect, test } from "bun:test";
import { DEFAULTS, parseConfig } from "../src/config.ts";

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
    ].join("\n"))).toEqual({
      pollSeconds: 15,
      maxPrs: 25,
      showOwner: "always",
      colour: false,
      searchQuery: "is:pr is:open review-requested:@me",
      tokenThrottleSeconds: 0,
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
  });
});
