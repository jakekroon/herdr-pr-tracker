import { describe, expect, test } from "bun:test";
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_RECONCILE_MS,
  type FocusSample,
  watchFocus,
} from "../src/watch.ts";

/**
 * Drive `watchFocus` over a scripted sequence of readings.
 *
 * The clock advances by `tickMs` per reading, so a script's length is also how
 * much time passed — which is what the reconcile behaviour is expressed in.
 * `sleep` resolves immediately: the loop's ordering is under test, not its
 * pacing.
 */
async function drive(
  script: (FocusSample | null)[],
  opts: { tickMs?: number; reconcileMs?: number; onTab?: (t: string) => Promise<void> } = {},
) {
  const tickMs = opts.tickMs ?? DEFAULT_INTERVAL_MS;
  const tabs: string[] = [];
  const panes: string[] = [];
  let clock = 0;
  let i = 0;
  await watchFocus({
    sample: async () => script[i++] ?? null,
    onTabChanged: async (t) => {
      tabs.push(t);
      if (opts.onTab) await opts.onTab(t);
    },
    onPaneChanged: async (p) => {
      panes.push(p);
    },
    sleep: async () => {
      clock += tickMs;
    },
    now: () => clock,
    running: () => i < script.length,
    reconcileMs: opts.reconcileMs,
  });
  return { tabs, panes };
}

const at = (tab: string, pane: string): FocusSample => ({ tabId: tab, paneId: pane });

describe("watchFocus", () => {
  test("seeds on the first reading without moving the widget", async () => {
    // Whatever opened the pane has just placed it. Firing here would be a move
    // the user watches happen for no reason.
    const { tabs, panes } = await drive([at("wA:t1", "wA:p1"), at("wA:t1", "wA:p1")]);
    expect(tabs).toEqual([]);
    expect(panes).toEqual([]);
  });

  test("places the widget in the tab focus moved to", async () => {
    const { tabs } = await drive([
      at("wA:t1", "wA:p1"),
      at("wB:t1", "wB:p1"),
    ]);
    expect(tabs).toEqual(["wB:t1"]);
  });

  test("acts once per tab, not once per reading", async () => {
    // The poll is four times a second and the user is not. Re-placing a widget
    // that is already where it belongs is a move on screen, not a no-op.
    const { tabs } = await drive([
      at("wA:t1", "wA:p1"),
      at("wB:t1", "wB:p1"),
      at("wB:t1", "wB:p1"),
      at("wB:t1", "wB:p1"),
    ]);
    expect(tabs).toEqual(["wB:t1"]);
  });

  test("follows every tab of a burst, ending on the one focus settled in", async () => {
    const { tabs } = await drive([
      at("wA:t1", "wA:p1"),
      at("wB:t1", "wB:p1"),
      at("wC:t1", "wC:p1"),
      at("wD:t1", "wD:p1"),
    ]);
    expect(tabs).toEqual(["wB:t1", "wC:t1", "wD:t1"]);
    expect(tabs.at(-1)).toBe("wD:t1");
  });

  test("re-places on a quiet timer, at the tab focus is actually in", async () => {
    // Guards the failures that happen without focus moving: a placement that
    // lost a race, a plugin reload that reopened the pane elsewhere. The tab it
    // re-places into must be the last one *seen*, not the one it seeded with.
    const quiet = Array(8).fill(at("wB:t1", "wB:p1"));
    const { tabs } = await drive([at("wA:t1", "wA:p1"), ...quiet], {
      tickMs: 250,
      reconcileMs: 1000,
    });
    expect(tabs[0]).toBe("wB:t1");
    expect(tabs.length).toBeGreaterThan(1);
    expect(new Set(tabs)).toEqual(new Set(["wB:t1"]));
  });

  test("a real change restarts the quiet timer", async () => {
    // Four ticks of quiet at a 1000ms reconcile and a 250ms tick is exactly the
    // threshold, so a change on the fourth must push the reconcile out rather
    // than let it fire alongside.
    const { tabs } = await drive(
      [
        at("wA:t1", "wA:p1"),
        at("wA:t1", "wA:p1"),
        at("wA:t1", "wA:p1"),
        at("wB:t1", "wB:p1"),
        at("wB:t1", "wB:p1"),
      ],
      { tickMs: 250, reconcileMs: 1000 },
    );
    expect(tabs).toEqual(["wB:t1"]);
  });

  test("never re-places while the widget has nowhere recorded to go", async () => {
    // Nothing has ever reported focus, so the reconcile has no tab to aim at.
    const { tabs } = await drive(
      [
        { tabId: null, paneId: null },
        { tabId: null, paneId: null },
        { tabId: null, paneId: null },
        { tabId: null, paneId: null },
        { tabId: null, paneId: null },
      ],
      { tickMs: 250, reconcileMs: 500 },
    );
    expect(tabs).toEqual([]);
  });

  test("a failed query is skipped, and does not count as focus moving", async () => {
    // `null` is "the call failed", which is different from "nothing is
    // focused". Treating it as a reading would place the widget twice for one
    // switch: once on the blip, once on recovery.
    const { tabs } = await drive([
      at("wA:t1", "wA:p1"),
      null,
      null,
      at("wA:t1", "wA:p1"),
    ]);
    expect(tabs).toEqual([]);
  });

  test("focus that moved during an outage is acted on once it can be read", async () => {
    const { tabs } = await drive([
      at("wA:t1", "wA:p1"),
      null,
      at("wB:t1", "wB:p1"),
      at("wB:t1", "wB:p1"),
    ]);
    expect(tabs).toEqual(["wB:t1"]);
  });

  test("refreshes the token for a pane change inside one tab", async () => {
    // A split: same tab, different pane. The widget stays put; the sidebar
    // token is the thing that has to move.
    const { tabs, panes } = await drive([
      at("wA:t1", "wA:p1"),
      at("wA:t1", "wA:p2"),
    ]);
    expect(tabs).toEqual([]);
    expect(panes).toEqual(["wA:p2"]);
  });

  test("a placement that throws does not end the watch", async () => {
    // This loop is the only thing keeping the widget with the user. One failed
    // placement must cost one placement.
    let thrown = 0;
    const { tabs } = await drive(
      [at("wA:t1", "wA:p1"), at("wB:t1", "wB:p1"), at("wC:t1", "wC:p1")],
      {
        onTab: async (t) => {
          if (t === "wB:t1") {
            thrown += 1;
            throw new Error("move failed");
          }
        },
      },
    );
    expect(thrown).toBe(1);
    expect(tabs).toEqual(["wB:t1", "wC:t1"]);
  });

  test("placements never overlap", async () => {
    // Two concurrent placements resize the same pane twice and land it at a
    // width neither intended. The loop awaits each handler; this is what says
    // so, and it fails if that await is dropped.
    let depth = 0;
    let peak = 0;
    const { tabs } = await drive(
      [
        at("wA:t1", "wA:p1"),
        at("wB:t1", "wB:p1"),
        at("wC:t1", "wC:p1"),
        at("wD:t1", "wD:p1"),
      ],
      {
        onTab: async () => {
          depth += 1;
          peak = Math.max(peak, depth);
          await Bun.sleep(1);
          depth -= 1;
        },
      },
    );
    expect(tabs.length).toBe(3);
    expect(peak).toBe(1);
  });

  test("polls often enough to keep up with a person, and reconciles rarely", async () => {
    // The interval is the widget's worst-case lag before it starts moving; the
    // reconcile is how long a misplacement can survive. Both are load-bearing
    // numbers rather than taste.
    expect(DEFAULT_INTERVAL_MS).toBeLessThanOrEqual(250);
    expect(DEFAULT_RECONCILE_MS).toBeGreaterThanOrEqual(DEFAULT_INTERVAL_MS * 10);
  });
});
