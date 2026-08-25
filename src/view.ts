// Which pull requests the pane lists. A view is a mode, not a filter: exactly
// one is on screen, and the choice outlives the pane process, so it has to
// survive a round trip through a marker file written by a different process.
//
// Pure, and in its own module for the reason dock.ts is: state.ts is the I/O
// layer the tests never exercise, so logic that lives there is logic that can
// never go red.

/** Every view, in one place: the type, the default and the parser all derive
 * from this list, so adding a view cannot be half-done. */
export const VIEWS = ["authored", "inbound"] as const;

export type View = (typeof VIEWS)[number];

/** The view the widget has always had, and the one anything unrecognised
 * falls back to. */
export const DEFAULT_VIEW: View = VIEWS[0];

const NAMES = new Set<string>(VIEWS);

/**
 * Whether a string is exactly a view name.
 *
 * Stricter than `parseView` on purpose, and used where the string comes from
 * the manifest rather than from a file the plugin wrote: a mistyped action
 * argument should fail loudly at the action, not silently show the authored
 * view forever.
 */
export function isView(raw: string | null | undefined): raw is View {
  return typeof raw === "string" && NAMES.has(raw);
}

/**
 * Read a view name off the marker file.
 *
 * Anything unrecognised — a marker from a future version, a half-written file,
 * no file at all — is the authored view rather than an error. A widget that
 * refuses to start because it cannot parse a preference is worse than one that
 * starts in the view it has always had.
 */
export function parseView(raw: string | null | undefined): View {
  const name = (raw ?? "").trim();
  return NAMES.has(name) ? (name as View) : DEFAULT_VIEW;
}

/**
 * The cached list is keyed by view.
 *
 * One shared file would mean a widget reopened in the inbound view paints the
 * authored list until the first fetch lands — showing one view's rows under the
 * other view's heading, which is the same class of lie as showing stale rows as
 * fresh.
 */
export function snapshotFile(view: View): string {
  return `last-${view}.json`;
}
