// Which pull requests the pane lists. The choice outlives the pane process, so
// it goes through a marker file that another process writes.

/** The type, the default and the parser all derive from this list. */
export const VIEWS = ["authored", "inbound"] as const;

export type View = (typeof VIEWS)[number];

export const DEFAULT_VIEW: View = VIEWS[0];

const NAMES = new Set<string>(VIEWS);

/**
 * Stricter than `parseView`, for strings from the manifest: a mistyped action
 * argument must fail at the action.
 */
export function isView(raw: string | null | undefined): raw is View {
  return typeof raw === "string" && NAMES.has(raw);
}

/**
 * Read a view name off the marker file. Anything unrecognised gives the default
 * view: an unreadable preference must not stop the widget.
 */
export function parseView(raw: string | null | undefined): View {
  const name = (raw ?? "").trim();
  return NAMES.has(name) ? (name as View) : DEFAULT_VIEW;
}

/**
 * One cache file per view. A shared file would paint one view's rows under the
 * other view's heading until the first fetch lands.
 */
export function snapshotFile(view: View): string {
  return `last-${view}.json`;
}

export function otherView(view: View): View {
  return view === "authored" ? "inbound" : "authored";
}

/**
 * The switcher's label, longest first; the first that fits wins. The pane title
 * names the current view, so the label only says what the control does.
 * `GLYPHS` does not apply: these are words, and the last rung is a shape only
 * because a narrow pane has two columns left.
 */
export const SWITCHER_LABELS = ["toggle view", "toggle", "⇄"] as const;

/**
 * Set with `pane report-metadata --title`, never `pane rename`: rename rewrites
 * the pane's `label`, which `adoptWidget` matches on, and the widget would be
 * orphaned on every view change.
 */
export const VIEW_TITLE: Record<View, string> = {
  authored: "My PRs",
  inbound: "Awaiting Review",
};

/**
 * The switcher's URL. Inside the pane, `handleClick` matches this string and
 * changes the view. Where the pane does not get the click (a terminal that
 * passes it to Herdr, or a ctrl-click on a `[[link_handlers]]` entry), the URL
 * opens, so it is GitHub's own list of the same pull requests.
 */
export function viewUrl(view: View): string {
  return view === "inbound"
    ? "https://github.com/pulls/review-requested"
    : "https://github.com/pulls";
}

/**
 * The manifest pattern for `viewUrl(view)`. Herdr reads `pattern` as a Rust
 * regex, so the dots are escaped and both ends anchored: a link handler pattern
 * is global, and an unanchored one also matches longer URLs.
 */
export function viewUrlPattern(view: View): string {
  return `^${viewUrl(view).replace(/\./g, "\\.")}$`;
}
