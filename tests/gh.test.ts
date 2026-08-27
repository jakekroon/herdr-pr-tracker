import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classify } from "../src/gh.ts";

// The header has room for a few words, and "offline" versus "auth failed" is
// the difference between waiting and going to fix something.
describe("classify", () => {
  test.each([
    ["gh: To get started with GitHub CLI, please run: gh auth login", "auth", "auth failed"],
    ["HTTP 401: Bad credentials", "auth", "auth failed"],
    ["API rate limit exceeded for user ID 1", "rate", "rate limited"],
    ["You have exceeded a secondary rate limit", "rate", "rate limited"],
    ["dial tcp: lookup api.github.com: no such host", "network", "offline"],
    ["Post \"https://api.github.com/graphql\": i/o timeout", "network", "offline"],
    ["connection refused", "network", "offline"],
    ["HTTP 403: Resource not accessible", "rate", "forbidden"],
  ])("%s -> %s", (stderr, kind, message) => {
    const e = classify(stderr as string);
    expect(e.kind).toBe(kind as never);
    expect(e.message).toBe(message as string);
  });

  test("an unrecognised failure keeps its first line, truncated", () => {
    const e = classify("something entirely unexpected happened here and it went on\nsecond line");
    expect(e.kind).toBe("other");
    expect(e.message.length).toBeLessThanOrEqual(40);
    expect(e.message).not.toContain("second line");
  });

  test("empty stderr still produces a reason to show", () => {
    expect(classify("").message).toBe("gh failed");
  });
});

describe("the ignore list reaches every search", () => {
  // gh.ts spawns a subprocess, so there is no seam to assert the sent query
  // through. This reads the source instead — the same shape tests/manifest.test.ts
  // uses — because "a view cannot forget the ignore list" is an invariant the
  // comments in gh.ts *state*, and a stated invariant with no test is one that
  // breaks the next time a view is added.
  const src = readFileSync(new URL("../src/gh.ts", import.meta.url), "utf8");

  test("every search string sent to GitHub is wrapped in withIgnores", () => {
    // Each `-F` that carries a search query, and nothing else.
    const sent = [...src.matchAll(/`(?:q|\$\{s\.alias\})=([^`]*)`/g)].map((m) => m[1]!);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const q of sent) expect(q).toContain("withIgnores(");
  });

  // That neither fetch *can* be called without an ignore list is not asserted
  // here: `ignore` is a required parameter, so tsc refuses it, which is both
  // stronger than a regex over this file and the enforcement this repo already
  // leans on elsewhere.
});
