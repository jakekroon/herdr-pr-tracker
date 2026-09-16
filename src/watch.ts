// Noticing that you changed tab, when Herdr will not tell us.
//
// Herdr 0.9.0 stopped publishing focus changes that originate in the terminal
// UI. Measured 2026-09-16 against 0.9.0 (protocol 22), ten switches driven by
// keybinding: forty `tab.focus`/`workspace.focus` lines in `herdr-server.log`,
// **zero** plugin event hooks run, and **zero** events delivered to a socket
// subscriber holding all twenty-four subscription types. The same switches
// driven by `herdr workspace focus` produced a hook run and a subscription
// event each. Consistent with the 0.9.0 notes "The terminal UI now runs in each
// client" (#3487) and "Multiple clients can now view different workspaces and
// tabs independently" (#3526): focus now moves in the client and is mirrored
// into the server through a path that does not reach the event bus.
//
// So the event hooks in `herdr-plugin.toml` are dead for the case that matters,
// and the only surface that still sees the user is a state query — `pane list`
// reports the focused pane correctly however focus was changed. This polls it.
//
// It lives in the pane process for the reason the GitHub poll loop does: that
// is the one part of a plugin allowed to stay alive, and its lifetime is
// exactly right — a widget that is not on screen has nothing to keep docked.
//
// Everything here is injected, so the loop's decisions are testable without a
// running Herdr. `bin/pane.ts` supplies the real implementations.

/** Where the user is, as of one poll. */
export interface FocusSample {
  /** The focused pane's tab, or null when nothing reports focus. */
  tabId: string | null;
  /** The focused pane itself, or null. */
  paneId: string | null;
}

export interface WatchDeps {
  /** One reading of live focus. Null means the query failed — a blip, not an
   * answer, and deliberately distinct from a reading with no focused pane. */
  sample: () => Promise<FocusSample | null>;
  /** Put the widget in this tab. Must be idempotent: it is also called on the
   * reconcile tick, when nothing has changed. */
  onTabChanged: (tabId: string) => Promise<void>;
  /** The focused pane changed. Refreshes that pane's sidebar token. */
  onPaneChanged: (paneId: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** False ends the loop. The pane process never stops; tests do. */
  running: () => boolean;
  intervalMs?: number;
  reconcileMs?: number;
}

/**
 * How often focus is read.
 *
 * One `herdr pane list` per tick, measured at 8.9ms p50 against a
 * fifteen-pane session — so this is about 3.6% of a core, and the widget is
 * never more than a quarter-second behind you before it starts moving. Polling
 * is the only surface Herdr leaves.
 */
export const DEFAULT_INTERVAL_MS = 250;

/**
 * How long the widget may sit somewhere wrong before being put right anyway.
 *
 * The tab check is edge-triggered, which cannot see the failures that happen
 * without focus moving: a placement that lost a race, a plugin reload that
 * reopened the pane in whatever tab Herdr chose, a sibling plugin that took the
 * right-hand column. Re-running the placement on a quiet timer costs a settled
 * `followFocus`: two reads and no mutation, in exchange for a widget that comes
 * back on its own instead of waiting for you to change tab.
 */
export const DEFAULT_RECONCILE_MS = 5_000;

/**
 * Watch focus and act on it until `running()` says stop.
 *
 * The first sample seeds rather than fires: whatever opened the pane has just
 * placed it, and re-placing it immediately would be a move the user sees for
 * nothing.
 *
 * Handlers are awaited, so the loop cannot overlap itself — a placement takes
 * longer than the interval, and two concurrent ones resize the same pane twice.
 * That also coalesces a burst: ticks landing mid-placement are never taken, and
 * the sample after it carries the tab you ended up in.
 *
 * A handler that throws is swallowed. This loop is the only thing keeping the
 * widget with the user, and one failed placement must not be the end of it.
 */
export async function watchFocus(deps: WatchDeps): Promise<void> {
  const interval = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const reconcile = deps.reconcileMs ?? DEFAULT_RECONCILE_MS;

  let seeded = false;
  let lastTab: string | null = null;
  let lastPane: string | null = null;
  let lastAct = deps.now();

  while (deps.running()) {
    const seen = await deps.sample();

    // Null is a failed read, so nothing is concluded from it. `lastTab` is left
    // alone: if focus really did move while Herdr was unreachable, the next
    // successful sample differs from it and fires then.
    if (seen) {
      if (!seeded) {
        seeded = true;
        lastTab = seen.tabId;
        lastPane = seen.paneId;
        lastAct = deps.now();
      } else {
        if (seen.tabId && seen.tabId !== lastTab) {
          lastTab = seen.tabId;
          lastAct = deps.now();
          await run(() => deps.onTabChanged(seen.tabId as string));
        } else if (lastTab && deps.now() - lastAct >= reconcile) {
          lastAct = deps.now();
          await run(() => deps.onTabChanged(lastTab as string));
        }

        if (seen.paneId && seen.paneId !== lastPane) {
          lastPane = seen.paneId;
          await run(() => deps.onPaneChanged(seen.paneId as string));
        }
      }
    }

    await deps.sleep(interval);
  }
}

async function run(f: () => Promise<void>): Promise<void> {
  try {
    await f();
  } catch {
    // Best-effort by design — see `watchFocus`.
  }
}
