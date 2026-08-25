# herdr-pr-tracker

A [Herdr](https://herdr.dev) plugin that keeps a list of **every open pull
request you have authored**, across every repository you can see, docked on the
right of whatever tab you are looking at.

It answers one question: *what is the state of everything I have open?* — and it
only tracks. It never opens, closes, merges or comments on anything.

It has a second view, for the other half of the same problem: the pull requests
**waiting on you** as a reviewer. One pane, one view at a time — see
[Two views](#two-views).

```
   5 open · 2 need you · toggle · 12s ago

platform ───────────────────────────────── 1
   feat/job-idempotency              ◆ ⚑4  ✓
    #1526 Make the background job idemp… 39d

web-app ────────────────────────────────── 1
   fix/payload-fields                      ✓
    #12760 Trim the payload to the field… 4d
▪  chore/importer-dry-run              ⚑1  ✓
    #4417 Give the importer a dry-run mo… 4d

metrics-service ──────────────────────────
▪◌ feat/settings-tabs                      ✓
    #208 Split the settings page into ta… 2h
 ◌ chore/nightly-import                    ✓
    #412 Move the nightly import behind … 1h
```

One summary line, then a band per repository, then one pull request per pair of
lines: the branch and its status first, the number, title and the pull request's
own age second. **The title is a hyperlink** — click it and the pull request
opens in your browser.

## What each mark means

| Mark | Meaning | Colour |
|---|---|---|
| `✗` in the review column | Changes requested | red |
| `✗` in the check column | Checks failing | red |
| `⚑N` | `N` unresolved review threads | yellow |
| `◆` | A review is required and has not been given | magenta |
| `●` | Checks still running | blue |
| `✓` in the review column | Approved | green |
| `✓` in the check column | Checks passing | green |
| `◌` | Draft — dims the whole row | dim |
| **bold** branch | *My PRs only* — changes requested, failing checks or unresolved threads: the three that are yours to act on | — |
| `▪` | A Herdr workspace is open on this branch | dim |
| `◦` | *Awaiting Review only* — you are in the conversation but nobody asked you | plain |
| `N` at the end of a repository rule | *My PRs only* — how many of that repository's pull requests need you | the loudest of them |
| *nothing* | Ready for review, nothing to do | plain |

A pull request can carry several of these at once, so each is drawn separately —
nothing is hidden by something louder. The row's own colour is the loudest one it
carries, in this order: changes requested, failing checks, unresolved threads,
review required, checks running, approved, clean.

Some deliberate choices worth knowing:

- **A clean pull request is uncoloured.** If every row is coloured, the colour
  tells you nothing.
- **Emphasis is a second axis, not a seventh colour.** The palette is your Herdr
  theme's own sixteen and does not grow, so the three signals that are *your*
  work — changes requested, failing checks, unresolved threads — take bold as
  well as colour. They are also what the header counts as needing you.
- **A cancelled check is not a failure.** A cancelled run is nearly always one
  you superseded, and colouring it red teaches you to ignore red.
- **Checks still running are blue, not green.** "CI is still thinking" is the
  most common state of a fresh pull request, and showing it as passing is
  misleading.
- **A draft is dimmed, not greyed out.** A draft with failing checks still shows
  the failure, in dim red.
- **Every unresolved thread counts** — including ones you have already replied
  to. The widget reports what GitHub reports rather than guessing whose turn it
  is, so a thread the reviewer has not resolved keeps its row yellow.
- `▪` is the one thing GitHub's own pull request list cannot tell you: which of
  these you actually have checked out right now.

Ordering is **oldest first**, by creation date, and it never changes as statuses
change — rows do not jump around while you glance at them. Drafts stay in date
position.

If the list is taller than the pane, the rows are **halved before any of them is
dropped**: the title line goes and its hyperlink moves onto the branch, so a
squeezed pane still shows every pull request, its signals and its link. Only when
even that overflows are rows dropped, and then the *oldest* go, with a `… +N
older` row standing in for them — your newest work is never what falls off the
end. The marker always sits next to the rows it stands for, so it is the first
row in this view and the last one in the other (see [Two views](#two-views)).

## Two views

The pane lists one of two things, and **the pane's own title says which**:

| Pane title | Shows |
|---|---|
| **My PRs** | The pull requests you opened. The default. The *authored* view, in the code and below. |
| **Awaiting Review** | The pull requests waiting on you: your review was asked for, you have already given one, or you are in the conversation. The *inbound* view. |

The dim toggle in the middle of the summary line is the control — `toggle view`
where there is room for it, and just `toggle` where there is not, as in the first
example above. **Click it** and the pane switches, and the title changes with it.
No modifier, no setup.

The pane reads its own mouse, so a click on any pull request opens it in the
browser too. The same toggle is reachable from `herdr plugin action invoke` and
from a keybinding you bind yourself (see below).

The control buys its columns from whatever the summary and the age leave over:
a narrow pane shortens it to `toggle` and then to `⇄`, and one narrower still
drops it altogether — the count and the age are what the line exists to say.

```
    3 inbound · toggle view · 12s ago

platform ─────────────────────────────────
    priya chore/toolchain                  ●
     #104 Bump the pinned toolchain       2d
  ◦ wren chore/seeds                       ✓
     #105 Tidy the seed script           10d

web-app ──────────────────────────────────
    priya fix/webhook-retry          ◆     ✗
     #101 Retry the webhook dispatcher o… 5d
```

The inbound view is the same widget with three things changed, all for the same
reason — the work is somebody else's:

- **Rows lead with the author**, not the branch. The branch follows it when
  there are columns spare. Your own branch names are how you think about your
  own work; somebody else's are not.
- **`◦` marks a row nobody asked you to look at** — you were assigned,
  mentioned, or you left a comment. A row with no mark is one where your review
  was actually requested, which is the ordinary reason to be here.
- **The colour order nearly inverts** — the same seven signals, ranked again:
  review required, checks running, clean, unresolved threads, failing checks,
  approved, changes requested. *Review required* leads, because it is the point
  of the view. *Changes requested* comes last, because it is usually your own
  verdict already delivered. Failing checks and unresolved threads sit low for
  the same reason: they are the author's job, and a red pull request is one it
  is too early to read.

There is no needs-you count, in the summary or on the bands, and no bold,
because every row in the view needs you. Ordering
is **newest first** here, the opposite of the authored view, and for a specific
reason: GitHub drops a review request the moment you review, so this view folds
in what you have *already* reviewed to let you watch what happens next — which
means the list does not empty by being worked. Its oldest rows are the ones you
have already dealt with, so those are what falls off the end.

The chosen view is remembered across restarts. Each view caches its own list, so
reopening the pane never shows one view's rows under the other one's heading.

## The sidebar token

The plugin also labels the focused agent pane's sidebar row with that pane's
branch's pull request — `#21288 ✓`, or `◌#21288 ✓` for a draft. Add `$pr` to your
agent row to see it:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", "tab", "$pr"], ["agent"]]
```

This replaces the `gh-pr` plugin, which did the same thing.

## Requirements

- Herdr >= 0.8.0
- `bun`, `git`, and `gh` on your `PATH`, with `gh auth status` clean

## Install

```bash
herdr plugin install jakekroon/herdr-pr-tracker
```

That is the whole install — no daemon, no config file, and nothing to build:
the plugin has no runtime dependencies, so there is no `bun install` step.

It prints what it is about to register and asks you to confirm. Where there is
no terminal to ask — a dotfiles bootstrap, a provisioning script, CI — it
refuses rather than assuming, so add `--yes`:

```bash
herdr plugin install jakekroon/herdr-pr-tracker --yes
```

Pin a version with `--ref` if you would rather not track `main`:

```bash
herdr plugin install jakekroon/herdr-pr-tracker --ref v0.1.1
```

To work on it instead, link a checkout — the same plugin, read from where you
edit it:

```bash
herdr plugin link /path/to/herdr-pr-tracker
```

### Uninstalling

**Close the widget first, then remove the plugin.** The order matters, and
getting it wrong leaves a process behind:

```bash
herdr plugin action invoke herdr-pr-tracker.toggle   # closes the pane
herdr plugin uninstall herdr-pr-tracker              # or: unlink, for a checkout
```

Removing the plugin does not stop the pane. The poll loop lives in the pane
process — that is what makes the widget work at all — and Herdr leaves it running
when the plugin it belongs to is unregistered. It then has no owner:
`herdr plugin pane close` answers `plugin_pane_not_found`, because Herdr will not
act on a plugin pane whose plugin it has forgotten, while the pane is still
listed and still asking GitHub for your pull requests every sixty seconds.

If you have already uninstalled and left one behind, the ordinary pane command
still reaches it — find it by its `prs` label:

```bash
herdr pane list | grep prs
herdr pane close <pane-id>
```

Uninstalling leaves the config and state directories alone, so a reinstall keeps
your width, your chosen view and your cached list. Delete
`herdr plugin config-dir herdr-pr-tracker` and the plugin's directory under
`~/.local/state/herdr/plugins` to start clean.

### Keybindings

A plugin cannot ship its own keybinding — Herdr has no action palette either, so
clicking the header switcher and `herdr plugin action invoke` are the two routes
that need no setup. To reach the actions by keystroke, add them to `~/.config/herdr/config.toml` and run `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+p"
type = "plugin_action"
command = "herdr-pr-tracker.toggle"
description = "toggle the PR pane"

[[keys.command]]
key = "prefix+i"
type = "plugin_action"
command = "herdr-pr-tracker.refresh"
description = "refresh PR status"

[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "herdr-pr-tracker.view-toggle"
description = "toggle PR view"
```

The view toggle opens the pane if it is closed, so it does not need `toggle`
first.

Avoid `alt+` chords (they emit characters in the terminal), and pick keys that do
not collide with the built-ins: `o`, `g`, `r`, `v` and `e` are taken.

## Configuration

Optional. `cp config.example config`, or drop a `config` in
`herdr plugin config-dir herdr-pr-tracker` — the plugin config dir is read second
and wins. Every setting is documented in `config.example`.

The one worth knowing about is `SEARCH_QUERY`: it is the whole definition of the
**authored** view, so pointing it somewhere else re-aims that view entirely.

It deliberately does not reach the inbound view. That view's three searches are
what tell a row you were *asked* from a row you are merely *involved* in, and an
override would change what `◦` means with no way for you to notice.

Glyphs, colours, precedence and sort order are deliberately **not** configurable.
A widget whose meaning depends on settings is a widget you have to remember the
settings of before you can read it.

## How it works

One `gh api graphql` request per poll fetches every pull request and everything
about it. Rate-limit cost is charged per `search` field rather than per pull
request, so the authored view costs the same whatever comes back and the inbound
view — three searches aliased into one document — costs proportionally more; both
are a rounding error against the 5000/hour budget at the default 60-second poll.
Every response carries `rateLimit { cost remaining }` if you want the real
number. Unresolved review threads are the reason it is GraphQL and not
`gh pr list`: `isResolved` exists nowhere else.

Herdr has no background-poll mechanism for plugins, so the poll loop lives in the
pane process itself — the one part of a plugin allowed to stay alive. The pane
follows you between tabs by being *moved* rather than reopened, so the list stays
on screen through the trip.

It never shows stale data as though it were fresh. The header carries the age of
what is on screen; past two poll intervals it turns yellow, and a failed refresh
turns it red and says why (`auth failed`, `offline`, `rate limited`) while still
admitting how old the rows are. An empty list says `0 open` — `0 inbound` in the other view — and `✓ all clear`, so
"nothing to do" is never confusable with "the widget is broken".

The pane takes no keyboard input and cannot be typed into or killed with a
keystroke. It **does** claim the mouse, in press/release SGR reporting only. That
reverses the original design, and for a measured reason: on iTerm2 a ctrl-click —
the modifier Herdr's own link handling is keyed to — never reaches the terminal,
because macOS claims it as the secondary click. The plain click is the only one a
pane can act on, and a pane only gets it by claiming the mouse. The cost is that
Herdr no longer resolves this pane's hyperlinks, so the pane opens them itself,
and only `http(s)` ones. The clickable spans are derived from the frame that was
actually painted, so whatever is hyperlinked is clickable.

## Development

```bash
tests/run.sh    # everything below, and what CI runs
```

or the two halves separately:

```bash
bun test        # 293 tests: no network, no gh, no Herdr
bunx tsc --noEmit
```

`tests/manifest.test.ts` is the one that is not about rendering: it checks the
manifest against the code it points at, because a stale command path or an
unmatched link-handler pattern fails at runtime inside a hook, where nobody is
watching.

The widget's whole design turns on one distinction: **draft is a modifier on
open, not an alternative to it.** A draft is still open, still yours, and still
needs you — it is just not asking anyone else for anything yet, so it is dimmed
rather than dropped.
