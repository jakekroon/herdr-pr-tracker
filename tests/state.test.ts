import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placementInFlight, releasePlacementLock, takePlacementLock } from "../src/state.ts";

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
