// The one thing this plugin took back from Herdr.
//
// Herdr resolves an OSC 8 click itself and opens the browser, which is why the
// pane used to leave the mouse alone. It cannot any more: on iTerm2 — measured,
// 2026-08-25 — a ctrl-click never reaches the terminal as a modified left click
// (macOS claims it as the secondary click) and a cmd-click arrives carrying the
// *meta* bit, indistinguishable from Option. Herdr's `[[link_handlers]]` route
// is keyed to ctrl-click, so it is unreachable there, and the plain click is
// the only one a pane can act on. Claiming the mouse to get it means Herdr no
// longer resolves this pane's hyperlinks, so the pane opens them itself.
//
// Spawning, so the tests never exercise it; the decision of *what* to open is
// in `render.ts` and `view.ts`, where it can go red.

/** The platforms the manifest declares. `open` is macOS, `xdg-open` is the
 * freedesktop convention every Linux desktop implements. */
const OPENER = process.platform === "darwin" ? "open" : "xdg-open";

/**
 * Hand a URL to the desktop, detached and silent.
 *
 * Failure is deliberately swallowed: a widget that cannot open a browser must
 * still keep listing pull requests, and there is nowhere in a one-line-per-PR
 * pane to report it that would not cost a row.
 */
export function openUrl(url: string): void {
  // Only ever a URL this plugin rendered, and only ever http(s) — the opener is
  // a shell-less spawn, but a `file:` or `javascript:` URL arriving from a
  // future code path should still not be handed to the desktop.
  if (!/^https?:\/\//.test(url)) return;
  try {
    Bun.spawn([OPENER, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // Nothing to do, and nowhere to say it.
  }
}
