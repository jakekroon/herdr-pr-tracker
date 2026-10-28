import { describe, expect, test } from "bun:test";
import { DEFAULT_VIEW, isView, parseView, snapshotFile, type View } from "../src/view.ts";

describe("parseView", () => {
  test("reads the two view names", () => {
    expect(parseView("authored")).toBe("authored");
    expect(parseView("inbound")).toBe("inbound");
  });

  test("tolerates the whitespace a marker file carries", () => {
    expect(parseView(" inbound\n")).toBe("inbound");
  });

  test("falls back to the authored view rather than throwing", () => {
    expect(parseView("reviewer")).toBe(DEFAULT_VIEW);
    expect(parseView("")).toBe(DEFAULT_VIEW);
    expect(parseView(null)).toBe(DEFAULT_VIEW);
    expect(parseView(undefined)).toBe(DEFAULT_VIEW);
    expect(DEFAULT_VIEW).toBe("authored");
  });
});

describe("snapshotFile", () => {
  test("keys the cache by view", () => {
    // One shared file would paint the authored list under the inbound view.
    expect(snapshotFile("authored")).toBe("last-authored.json");
    expect(snapshotFile("inbound")).toBe("last-inbound.json");
  });

  test("never collides between views", () => {
    const views: View[] = ["authored", "inbound"];
    expect(new Set(views.map(snapshotFile)).size).toBe(2);
  });
});

describe("isView", () => {
  test("accepts only exact view names", () => {
    expect(isView("inbound")).toBe(true);
    expect(isView("authored")).toBe(true);
    expect(isView(" inbound ")).toBe(false);
    expect(isView("reviewer")).toBe(false);
    expect(isView(undefined)).toBe(false);
  });
});
