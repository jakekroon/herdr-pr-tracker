// The pane claims the mouse because Herdr's ctrl-click `[[link_handlers]]`
// route never fires on iTerm2: macOS takes ctrl-click as the secondary click.
// With the mouse claimed, Herdr no longer opens this pane's OSC 8 links, so the
// pane opens them itself.

const OPENER = process.platform === "darwin" ? "open" : "xdg-open";

/**
 * Hand a URL to the desktop, detached. A failure is ignored: the pane has no
 * row to spare for the report, and the list must keep working.
 */
export function openUrl(url: string): void {
  if (!/^https?:\/\//.test(url)) return;
  try {
    Bun.spawn([OPENER, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch {}
}
