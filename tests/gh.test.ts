import { describe, expect, test } from "bun:test";
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
