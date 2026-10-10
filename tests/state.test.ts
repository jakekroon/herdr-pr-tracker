import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  placementInFlight,
  readTabWidth,
  recordPlacedWidth,
  recordTabWidth,
  releasePlacementLock,
  takePlacementLock,
} from "../src/state.ts";

// The only tests here that touch the filesystem: the placement lock is the one
// writer that does not go through `Bun.write`, so it is the one place a missing
// state dir is not created for it.
const roots: string[] = [];

function useFreshStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "prs-state-"));
  roots.push(root);
  // Nested and absent, exactly as a checkout Herdr has never run sees it.
  const dir = join(root, "never", "created");
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  return dir;
}

afterEach(() => {
  delete process.env.HERDR_PLUGIN_STATE_DIR;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("takePlacementLock", () => {
  // The measured bug: `follow` exited 0 having placed nothing, with empty
  // stderr, on any checkout where no other entrypoint had made the state dir.
  test("creates the state dir rather than failing on a checkout that has none", async () => {
    const dir = useFreshStateDir();
    expect(existsSync(dir)).toBe(false);

    expect(await takePlacementLock()).toBe(true);

    expect(existsSync(join(dir, "placing.lock"))).toBe(true);
    expect(placementInFlight()).toBe(true);
  });

  test("still refuses a second holder once the dir exists", async () => {
    useFreshStateDir();
    expect(await takePlacementLock()).toBe(true);
    expect(await takePlacementLock()).toBe(false);
  });

  test("releasing lets the next run take it", async () => {
    useFreshStateDir();
    expect(await takePlacementLock()).toBe(true);
    releasePlacementLock();
    expect(placementInFlight()).toBe(false);
    expect(await takePlacementLock()).toBe(true);
  });
});

describe("tab widths", () => {
  test("a width recorded in one tab leaves every other tab at no record", () => {
    useFreshStateDir();
    recordTabWidth("w1:t1", 0.35);

    expect(readTabWidth("w1:t1").width).toBe(0.35);
    expect(readTabWidth("w2:t1")).toEqual({ width: null, placed: null });
  });

  test("recording a width drops that tab's placement shortfall and no other", () => {
    useFreshStateDir();
    recordPlacedWidth("w1:t1", 0.25);
    recordPlacedWidth("w2:t1", 0.18);
    recordTabWidth("w1:t1", 0.3);

    expect(readTabWidth("w1:t1")).toEqual({ width: 0.3, placed: null });
    expect(readTabWidth("w2:t1")).toEqual({ width: null, placed: 0.18 });
  });

  test("a placement keeps the tab's chosen width", () => {
    useFreshStateDir();
    recordTabWidth("w1:t1", 0.3);
    recordPlacedWidth("w1:t1", 0.27);
    expect(readTabWidth("w1:t1")).toEqual({ width: 0.3, placed: 0.27 });

    recordPlacedWidth("w1:t1", null);
    expect(readTabWidth("w1:t1")).toEqual({ width: 0.3, placed: null });
  });

  test("an unreadable file reads as no record rather than failing", () => {
    const dir = useFreshStateDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "widths.json"), "{trunc");

    expect(readTabWidth("w1:t1")).toEqual({ width: null, placed: null });
    recordTabWidth("w1:t1", 0.3);
    expect(readTabWidth("w1:t1").width).toBe(0.3);
  });
});
