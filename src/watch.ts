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
  activeMs?: number;
  idleMs?: number;
  activeWindowMs?: number;
  reconcileMs?: number;
}

/**
 * How often focus is read while you are moving around, and once you have
 * stopped.
 *
 * The number that matters is how long the widget is missing from a tab you have
 * just arrived in. Under 0.8 the hook path did it in 53ms, measured: Herdr
 * dispatched the hook in the same millisecond as the focus event, and the
 * `pane.move` landed 53ms later. A poll cannot beat that, but it can get close
 * enough that the widget arrives with the tab rather than popping in after it —
 * the placement itself is 60ms, so the poll interval is the whole of the
 * difference.
 *
 * One `herdr pane list` costs 8.9ms p50 against a fifteen-pane session, so the
 * active rate is about 11% of a core and the idle rate about 1.5%. Paying the
 * active rate all the time would be wasteful for a widget that mostly watches
 * someone type, and paying the idle rate all the time puts the widget half a
 * second behind every switch. Switching comes in bursts, so the rate follows
 * the bursts.
 */
export const DEFAULT_ACTIVE_MS = 80;
export const DEFAULT_IDLE_MS = 600;

/** How long after a change the fast rate is kept. Long enough to cover a pause
 * in the middle of a burst of switches, short enough that walking away from the
 * keyboard costs the idle rate. */
export const DEFAULT_ACTIVE_WINDOW_MS = 8_000;

/**
 * The gap before the next reading, given how long ago focus last moved.
 *
 * Pure, and exported, because the pacing is the whole user-visible quality of
 * this thing and it should be assertable without running a loop.
 */
export function pollInterval(
  msSinceChange: number,
  activeMs = DEFAULT_ACTIVE_MS,
  idleMs = DEFAULT_IDLE_MS,
  activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS,
): number {
  return msSinceChange < activeWindowMs ? activeMs : idleMs;
}

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
  const activeMs = deps.activeMs ?? DEFAULT_ACTIVE_MS;
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const activeWindowMs = deps.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  const reconcile = deps.reconcileMs ?? DEFAULT_RECONCILE_MS;

  let seeded = false;
  let lastTab: string | null = null;
  let lastPane: string | null = null;
  let lastAct = deps.now();
  // Starts hot: the pane has just opened, which usually means you are in the
  // middle of doing something to it.
  let lastChange = deps.now();

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
        // One flag for both, and not an assignment in each branch: you cannot
        // change tab in Herdr without changing focused pane, so a per-branch
        // update would have a copy that no realistic reading can reach on its
        // own — untestable by construction, and therefore free to rot.
        let changed = false;

        if (seen.tabId && seen.tabId !== lastTab) {
          lastTab = seen.tabId;
          lastAct = deps.now();
          changed = true;
          await run(() => deps.onTabChanged(seen.tabId as string));
        } else if (lastTab && deps.now() - lastAct >= reconcile) {
          // Housekeeping, not you doing something, so it deliberately does not
          // hold the fast rate open.
          lastAct = deps.now();
          await run(() => deps.onTabChanged(lastTab as string));
        }

        if (seen.paneId && seen.paneId !== lastPane) {
          lastPane = seen.paneId;
          changed = true;
          await run(() => deps.onPaneChanged(seen.paneId as string));
        }

        if (changed) lastChange = deps.now();
      }
    }

    await deps.sleep(
      pollInterval(deps.now() - lastChange, activeMs, idleMs, activeWindowMs),
    );
  }
}

async function run(f: () => Promise<void>): Promise<void> {
  try {
    await f();
  } catch {
    // Best-effort by design — see `watchFocus`.
  }
}
