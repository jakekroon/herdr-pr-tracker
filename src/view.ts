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

/**
 * The view you are not in.
 *
 * Two views means one "other", so the header's switcher never has to choose
 * what to offer — and adding a third view would make this stop compiling
 * rather than silently pick one.
 */
export function otherView(view: View): View {
  return view === "authored" ? "inbound" : "authored";
}

/**
 * What the switcher wears, longest first.
 *
 * It no longer names a view. The pane's *title* says which view you are in —
 * Herdr paints it on the pane header, where it costs no columns the list wants
 * — so the control in the header line only has to say what it does, and one
 * label serves both views. Naming the target view as well would be the same
 * fact in two places, and the shorter of the two would be the one that drifts.
 *
 * Offered longest-first and the first that fits wins, the same shape
 * `branchLine` uses for its trailing text: a narrow pane keeps a control that
 * says less rather than losing it altogether.
 */
export const SWITCHER_LABELS = ["toggle view", "toggle", "⇄"] as const;

/**
 * The pane title, which is the one place the current view is named outright.
 *
 * Set with `pane report-metadata --title`, **not** `pane rename`: rename
 * rewrites the pane's `label`, which is the discriminator `adoptWidget` matches
 * on, so a per-view label would orphan the widget every time the view changed.
 * The metadata title is display-only and leaves `label` alone.
 */
export const VIEW_TITLE: Record<View, string> = {
  authored: "My PRs",
  inbound: "Awaiting Review",
};

/**
 * Where a click on the switcher goes.
 *
 * Inside the pane the URL is not opened at all: the pane claims the mouse, and
 * `handleClick` recognises this exact string as the switcher and changes the
 * view instead. So what the URL *is* only matters everywhere else — and a
 * plugin cannot guarantee it owns every click on its own links. A terminal that
 * hands the click to Herdr, or a ctrl-click routed to the registered
 * `[[link_handlers]]` entry, opens whatever this returns.
 *
 * Which is why it is GitHub's own list of exactly these pull requests, and not
 * the `herdr-pr-tracker://` scheme that was the first attempt: a private scheme
 * hands the OS a URL nothing can open, so the control becomes a dead end
 * wherever the mouse capture does not apply. This way it degrades to something
 * useful — the same pull requests, on the web.
 */
export function viewUrl(view: View): string {
  return view === "inbound"
    ? "https://github.com/pulls/review-requested"
    : "https://github.com/pulls";
}

/**
 * The manifest pattern that must match `viewUrl(view)`.
 *
 * `pattern` is a **Rust regular expression**, not a glob and not a literal, so
 * the dots are escaped and both ends are anchored: unanchored, these would also
 * match a longer URL that merely contains one of them. `tests/manifest.ts`
 * checks the manifest's own pattern against `viewUrl` rather than against this
 * — a copy that agreed with itself and not with the manifest would prove
 * nothing.
 */
export function viewUrlPattern(view: View): string {
  return `^${viewUrl(view).replace(/\./g, "\\.")}$`;
}
