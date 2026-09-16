import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ACTIVE_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  DEFAULT_IDLE_MS,
  DEFAULT_RECONCILE_MS,
  type FocusSample,
  pollInterval,
  watchFocus,
} from "../src/watch.ts";

/**
 * Drive `watchFocus` over a scripted sequence of readings.
 *
 * With `tickMs`, the clock advances by that much per reading, so a script's
 * length is also how much time passed — which is how the reconcile tests
 * express themselves. Without it the clock advances by whatever gap the loop
 * asked for, and `naps` records those gaps, which is how the pacing tests read
 * them. No test waits in real time.
 */
async function drive(
  script: (FocusSample | null)[],
  opts: {
    tickMs?: number;
    reconcileMs?: number;
    activeMs?: number;
    idleMs?: number;
    activeWindowMs?: number;
    onTab?: (t: string) => Promise<void>;
  } = {},
) {
  const tabs: string[] = [];
  const panes: string[] = [];
  const naps: number[] = [];
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
    // A fixed `tickMs` pins the clock so the reconcile tests can express
    // themselves in time; otherwise the loop's own adaptive gap advances it,
    // which is what the pacing tests are reading.
    sleep: async (ms) => {
      naps.push(ms);
      clock += opts.tickMs ?? ms;
    },
    now: () => clock,
    running: () => i < script.length,
    activeMs: opts.activeMs,
    idleMs: opts.idleMs,
    activeWindowMs: opts.activeWindowMs,
    reconcileMs: opts.reconcileMs,
  });
  return { tabs, panes, naps };
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
    // The poll runs many times a second and you do not. Re-placing a widget
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

  test("keeps the widget's worst-case lag under what a hook used to cost", async () => {
    // Herdr 0.8 dispatched the focus hook in the same millisecond as the event
    // and the move landed 53ms later, measured. A poll adds its interval to the
    // 60ms placement, so the active rate is the entire regression: at 80ms the
    // widget is late by at most 140ms rather than 53ms, which is the difference
    // between arriving with the tab and popping in after it.
    expect(DEFAULT_ACTIVE_MS).toBeLessThanOrEqual(100);
    expect(DEFAULT_IDLE_MS).toBeGreaterThanOrEqual(DEFAULT_ACTIVE_MS * 4);
    expect(DEFAULT_RECONCILE_MS).toBeGreaterThanOrEqual(DEFAULT_IDLE_MS * 4);
    expect(DEFAULT_ACTIVE_WINDOW_MS).toBeGreaterThan(DEFAULT_RECONCILE_MS);
  });

  test("backs off once focus has stopped moving, and speeds up again", () => {
    expect(pollInterval(0)).toBe(DEFAULT_ACTIVE_MS);
    expect(pollInterval(DEFAULT_ACTIVE_WINDOW_MS - 1)).toBe(DEFAULT_ACTIVE_MS);
    expect(pollInterval(DEFAULT_ACTIVE_WINDOW_MS)).toBe(DEFAULT_IDLE_MS);
    expect(pollInterval(DEFAULT_ACTIVE_WINDOW_MS * 100)).toBe(DEFAULT_IDLE_MS);
  });

  test("a quiet session polls at the idle rate", async () => {
    // Nothing has ever changed, so every gap after the seed is the slow one.
    const { naps } = await drive(
      Array(4).fill(at("wA:t1", "wA:p1")),
      { tickMs: 4000, activeMs: 50, idleMs: 700, activeWindowMs: 1000 },
    );
    expect(naps[0]).toBe(50);
    expect(naps.slice(1)).toEqual([700, 700, 700]);
  });

  test("a switch puts the poll back on the fast rate", async () => {
    // Two slow gaps, then focus moves: the gap after it must be the fast one,
    // or the next switch in the burst is found half a second late.
    const { naps } = await drive(
      [
        at("wA:t1", "wA:p1"),
        at("wA:t1", "wA:p1"),
        at("wA:t1", "wA:p1"),
        at("wB:t1", "wB:p1"),
      ],
      { tickMs: 4000, activeMs: 50, idleMs: 700, activeWindowMs: 1000, reconcileMs: 999_999 },
    );
    expect(naps).toEqual([50, 700, 700, 50]);
  });
});
