# herdr-pr-tracker

A [Herdr](https://herdr.dev) plugin that docks a list of **every open pull
request you have authored**, across every repository you can see, on the right
of the tab you are in.

It answers one question: *what state is everything I have open in?* It tracks
and does nothing else. It never opens, closes, merges or comments on anything.

A second view lists the pull requests **waiting on you** as a reviewer. The pane
shows one view at a time. See [Two views](#two-views).

```
   5 open · 2 need you · toggle · 12s ago

platform ───────────────────────────────── 1
   feat/job-idempotency              ◆ ⚑4  ✓
    #1526 Make the background job idemp… 39d

web-app ────────────────────────────────── 1
   fix/payload-fields                      ✓
    #12760 Trim the payload to the field… 4d
▪  chore/importer-dry-run          ⊘   ⚑1  ✓
    #4417 Give the importer a dry-run mo… 4d

metrics-service ──────────────────────────
▪◌ feat/settings-tabs                      ✓
    #208 Split the settings page into ta… 2h
 ◌ chore/nightly-import                    ✓
    #412 Move the nightly import behind … 1h
```

The pane draws one summary line, then a band per repository, then two lines per
pull request. Line one holds the branch and its status. Line two holds the
number, the title and the pull request's age. **The title is a hyperlink**:
click it to open the pull request in your browser.

## What each mark means

| Mark | Meaning | Colour |
|---|---|---|
| `⊘` | A conflict blocks the merge | red |
| `✗` in the review column | Changes requested | red |
| `✗` in the check column | Checks failing | red |
| `⚑N` | `N` unresolved review threads | yellow |
| `◆` | A required review is missing | magenta |
| `●` | Checks still running | blue |
| `✓` in the review column | Approved | green |
| `✓` in the check column | Checks passing | green |
| `◌` | Draft, and the whole row is dim | dim |
| **bold** branch | *My PRs only.* A conflict, changes requested, failing checks or unresolved threads: the four you act on | none |
| `▪` | A Herdr workspace is open on this branch | dim |
| `◦` | *Awaiting Review only.* You are in the conversation, but nobody asked you | plain |
| `N` at the end of a repository rule | *My PRs only.* How many of that repository's pull requests need you | the loudest of them |
| *nothing* | Ready for review, nothing to do | plain |
| `⚠` under the last band | A `config` problem, not a pull request. See [Configuration](#configuration) | yellow |

A pull request can carry several marks at once. The pane draws each one in its
own cell, so a louder mark never hides a quieter one. The row takes the colour of
its loudest mark, in this order: conflict, changes requested, failing checks,
unresolved threads, review required, checks running, approved, clean.

### Marks in a Nerd Font

The marks above are geometric shapes and dingbats, and **most monospace fonts
lack them**. Monaco, the macOS default, has one of the eleven (`◆`). The OS draws
the other ten from whichever proportional font has them, so the cluster can mix
several typefaces.

`GLYPHS=nerd` draws [Octicons](https://primer.style/octicons/), GitHub's own icon
set, in the same cells at the same widths with the same meanings. It also
separates two marks the default set merges: a review verdict and a build result
each get their own mark, where the default uses `✓` for both.

Set it in `config`. Use the copy beside the plugin (`cp config.example config`)
or the one in `herdr plugin config-dir herdr-pr-tracker`. The plugin reads the
second one last, so it wins:

```
GLYPHS=nerd
```

To switch back, set `GLYPHS=unicode` or delete the line. Write the name in lower
case. The plugin ignores any other value (`Nerd`, `octicons`, a typo) and keeps
the default without a warning. A typo that painted blank cells would cost you
more.

| Mark | Octicon | | Mark | Octicon |
|---|---|---|---|---|
| conflict | `no-entry` | | draft | `git-pull-request-draft` |
| changes requested | `x-circle` | | workspace open | `git-branch` |
| checks failing | `x` | | in the conversation | `comment` |
| unresolved threads | `comment-discussion` | | checks running | `dot-fill` |
| review required | `eye` | | approved | `check-circle` |
| config problem | `alert` | | checks passing | `check` |
| nothing open | `checklist` | | sidebar refreshing | `sync` |

You need a font that has them:

| Ghostty | nothing to do: Ghostty embeds Symbols Nerd Font 3.4.0 in its binary |
|---|---|
| **iTerm2** | `brew install --cask font-symbols-only-nerd-font`, then Profiles → Text → "Use a different font for non-ASCII text" |
| **elsewhere** | any patched [Nerd Font](https://www.nerdfonts.com) as the terminal font |

The pane reads its config once, at startup, and a plugin reload leaves the pane
process running. After you edit `GLYPHS`, close the widget and let it come back:

```sh
herdr plugin pane close <pane-id>   # the id from `herdr pane list`
```

A missing glyph shows as a blank cell, with no error, so check the pane when it
returns. The default stays `unicode`, which needs nothing installed.

The rules behind the colours and the marks:

- **A clean pull request has no colour.** If every row has a colour, colour tells
  you nothing.
- **Bold is a second axis.** The palette is your Herdr theme's sixteen colours
  and stays that size, so the four signals that are *your* work (a conflict,
  changes requested, failing checks, unresolved threads) take bold as well as
  colour. The header counts these four as needing you.
- **A conflict leads, in both views.** Only you can resolve it, and the rest of
  the pull request waits until you do: a review and a green build answer a
  question the branch cannot ask yet. Every row reserves the conflict column,
  plus a separator column, so the cluster stays aligned and evenly spaced down
  the pane. That costs every branch name two columns.
- **A conflict GitHub has not computed yet shows nothing.** GitHub computes
  mergeability on demand, so a pull request opened seconds ago reports no
  answer. The pane draws silence, not a clean merge, and a conflict can appear
  one poll after its row. The pane does not track *behind the base branch*. The
  one field that reports it reports a single merge state at a time, so the
  answer goes missing on pull requests blocked on something else.
- **A cancelled check is not a failure.** You cancelled most of those runs by
  pushing again, and a red mark for them teaches you to ignore red.
- **Running checks are blue.** A fresh pull request spends most of its first
  minutes in this state, and a green mark would claim a pass that has not
  happened.
- **A draft is dim.** A draft with failing checks still shows the failure, in
  dim red.
- **Every unresolved thread counts**, including threads you replied to. The
  widget reports GitHub's count and does not guess whose turn it is, so a thread
  the reviewer leaves open keeps its row yellow.
- `▪` tells you something GitHub's own pull request list cannot: which of these
  branches you have checked out now.

The list runs **oldest first**, by creation date, and status changes never
reorder it, so rows stay put while you glance at them. Drafts keep their date
position.

When the list is taller than the pane, **every row drops to one line before any
row goes**. The title line goes, and its hyperlink moves onto the branch, so a
short pane still shows every pull request, its signals and its link. Only when
that still overflows does the pane drop rows. It drops the *oldest* and puts a
`… +N older` row in their place, so your newest work stays on screen. The marker
sits next to the rows it replaces: first in this view, last in the other (see
[Two views](#two-views)).

## Two views

The pane lists one of two things, and **the pane title names it**:

| Pane title | Shows |
|---|---|
| **My PRs** | The pull requests you opened. The default. The code and this README call it the *authored* view. |
| **Awaiting Review** | The pull requests waiting on you: someone asked for your review, you already gave one, or you are in the conversation. The *inbound* view. |

The dim toggle in the middle of the summary line is the control. It reads
`toggle view` when it fits and `toggle` when space is short, as in the first
example. **Click it** to switch the view. The title changes with it. It needs no
modifier and no setup.

The pane reads its own mouse, so a click on any pull request opens it in the
browser. You can also reach the toggle from `herdr plugin action invoke` or from
a keybinding you add (see below).

The control takes the columns the summary and the age leave free. A narrow pane
shortens it to `toggle` and then `⇄`, and a narrower pane drops it, because the
line exists to show the count and the age.

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

The inbound view changes three things, all because the work belongs to someone
else:

- **Rows lead with the author.** The branch follows when columns are spare. You
  think about your own work by branch name, and about other people's by who
  wrote it.
- **`◦` marks a row nobody asked you to look at.** You were assigned, mentioned,
  or you commented. A row with no mark is one where someone requested your
  review, the usual reason a row is here.
- **Below first place, the colour order almost inverts.** The same eight signals
  rank as: conflict, review required, checks running, clean, unresolved threads,
  failing checks, approved, changes requested. *Conflict* leads both views,
  because a reviewer cannot review a conflicting pull request, and "do not read
  this yet" is the loudest thing a row can say. *Review required* leads the
  rest, because it is why the view exists. *Changes requested* comes last,
  because it is usually your own verdict. Failing checks and unresolved threads
  rank low for the same reason: the author owns them, and a red pull request is
  too early to read.

The inbound view has no needs-you count, in the summary or on the bands, and no
bold, because every row in it needs you. It sorts **newest first**, the opposite
of the authored view. GitHub drops a review request the moment you review, so
this view also includes pull requests you *already* reviewed, to let you watch
what happens next. Working through the list does not empty it. Its oldest rows
are the ones you dealt with, so those fall off the end first.

The plugin remembers your chosen view across restarts. Each view caches its own
list, so a reopened pane never shows one view's rows under the other's heading.

## The sidebar token

The plugin also labels the focused agent pane's sidebar row with the pull
request for that pane's branch: `#21288 ✓`, or `◌#21288 ✓` for a draft. Add
`$pr` to your agent row to see it:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", "tab", "$pr"], ["agent"]]
```

It replaces the `gh-pr` plugin, which did the same job.

## Requirements

- Herdr >= 0.8.0, the first release with `plugin pane`,
  `pane report-metadata --title` and `link_handlers`
- `bun` >= 1.2, for `Bun.file().delete()`, which clears the state files
- `gh` >= 2.24, with `gh auth status` clean, for `gh pr checks --json`
- `git` on your `PATH`

## Install

```bash
herdr plugin install jakekroon/herdr-pr-tracker
```

That is the whole install. There is no daemon, no config file and no build step.
The plugin has no runtime dependencies, so you skip `bun install`.

Herdr prints what it will register and asks you to confirm. With no terminal to
ask (a dotfiles bootstrap, a provisioning script, CI), it refuses, so add
`--yes`:

```bash
herdr plugin install jakekroon/herdr-pr-tracker --yes
```

To pin a version instead of tracking `main`, add `--ref`:

```bash
herdr plugin install jakekroon/herdr-pr-tracker --ref v0.5.1
```

To work on the plugin, link a checkout. Herdr then runs the plugin from where you
edit it:

```bash
herdr plugin link /path/to/herdr-pr-tracker
```

### Uninstalling

**Close the widget first, then remove the plugin.** The other order leaves a
process behind:

```bash
herdr plugin action invoke herdr-pr-tracker.toggle   # closes the pane
herdr plugin uninstall herdr-pr-tracker              # or: unlink, for a checkout
```

Removing the plugin leaves the pane running. The poll loop lives in the pane
process, and Herdr keeps that process alive after it unregisters the plugin.
Nothing owns the pane then. `herdr plugin pane close` answers
`plugin_pane_not_found`, because Herdr no longer knows the plugin, while the pane
stays listed and keeps asking GitHub for your pull requests every sixty seconds.

If you already uninstalled and left one behind, the ordinary pane command still
reaches it. Find it by its `prs` label:

```bash
herdr pane list | grep prs
herdr pane close <pane-id>
```

Uninstalling leaves the config and state directories in place, so a reinstall
keeps your widths, your chosen view and your cached list. To start clean, delete
`herdr plugin config-dir herdr-pr-tracker` and the plugin's directory under
`~/.local/state/herdr/plugins`.

### Keybindings

A plugin cannot ship a keybinding, and Herdr has no action palette. Without
setup, you have two routes: click the header toggle, or run
`herdr plugin action invoke`. To reach the actions by key, add them to
`~/.config/herdr/config.toml` and run `herdr server reload-config`:

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

The view toggle opens the pane if it is closed, so you do not need `toggle`
first.

Avoid `alt+` chords, which type characters in the terminal. Pick keys clear of
the built-ins: `o`, `g`, `r`, `v` and `e` are taken.

## Configuration

Optional. Run `cp config.example config`, or put a `config` in
`herdr plugin config-dir herdr-pr-tracker`. The plugin reads the config dir copy
last, so it wins. `config.example` documents every setting. Values can be quoted
or bare. The pane reads its config once, at startup, so toggle the widget off and
on after an edit.

`SEARCH_QUERY` defines the **authored** view in full, so changing it re-aims
that view.

It does not touch the inbound view. That view's three searches tell a row you
were *asked* about from a row you are *involved* in, and an override would change
what `◦` means without you noticing.

`IGNORE_REPOS` lists repositories and owners the pane never fetches, in
**either** view:

```
IGNORE_REPOS="acme/web-app acme/"
```

`acme/web-app` is one repository. `acme/` is every repository under one owner.
Spaces or commas separate entries. GitHub's qualifiers ignore case, so
`Acme/Web-App` and `acme/web-app` count as one entry.

Each entry needs its slash. The plugin **drops** a bare `web-app`, because GitHub
answers an owner-less repository qualifier by subtracting nothing and reporting
no error. A filter that refuses beats one that does not filter and says nothing.

The pane reports dropped entries with `⚠ 2 bad IGNORE_REPOS entries` at the foot
of the list (`⚠ 1 bad IGNORE_REPOS entry` for one). The line gives only the count,
because the pane is narrow. To see *which* entries, run the pane process by hand
(`bun bin/pane.ts`). It names them on stderr before it takes the screen. In a
Herdr pane, the screen covers that stderr line at once, so treat the count as the
signal and `config` as the place to look.

The notice reflects the config **at pane startup**, because the pane reads
`config` once. A fixed entry clears the line at the next restart, not the next
poll. The pane reserves the notice's row out of its height, so a long list cannot
push it off the bottom. Width is another matter: a narrow pane truncates the
message, and a narrower one drops the line rather than wrap it and scroll the
header away.

`IGNORE_REPOS` *does* reach the inbound view, because removing a row cannot
change what the remaining rows mean. Both views subtract at the search, so the
pane never learns what it left out. There is no "N ignored" count, and `0 open`
with `✓ all clear` describes what you track, not GitHub.

`MAX_IDLE_DAYS` hides pull requests with no update in that many days, in
**either** view:

```
MAX_IDLE_DAYS=30
```

"Update" means GitHub's `updated` date. A comment, a push, a review or a label
keeps a pull request in, whatever its age, and so do bots and a finished CI run.
The age on a row still counts from when it opened. Like `IGNORE_REPOS`, it
subtracts at the search, so there is no "N hidden" count. Unset or `0` means no
cutoff.

You cannot configure signal precedence, sort order or what a mark *means*. If a
widget's meaning depended on settings, you would have to recall the settings
before you could read it. `GLYPHS` and `COLOR` describe what your terminal can
draw, not what a row means, so they fit the rule. See
[Marks in a Nerd Font](#marks-in-a-nerd-font) for the glyph swap.

## How it works

One `gh api graphql` request per poll fetches every pull request and all its
details. GitHub charges rate limit per `search` field, not per pull request, so
the authored view costs the same whatever comes back. The inbound view aliases
three searches into one document and costs three times as much. Measured: **5
points for the authored view and 15 for the inbound one**. At the default
60-second poll, that is a rounding error against the 5000/hour budget. Every
response carries `rateLimit { cost remaining }`, so you can check these numbers
yourself. The plugin uses GraphQL, not `gh pr list`, for unresolved review
threads: `isResolved` exists nowhere else.

Herdr gives plugins no background poll, so the poll loop lives in the pane
process, the one part of a plugin that stays alive. Herdr *moves* the pane
between tabs instead of reopening it, so the list stays on screen through the
trip.

The pane never passes stale data off as fresh. The header shows the age of what
is on screen. Past two poll intervals the age turns yellow. A failed refresh
turns it red and gives the reason (`auth failed`, `offline`, `rate limited`),
and the header still shows how old the rows are. An empty list says `0 open`
(`0 inbound` in the other view) and `✓ all clear`, so you can tell "nothing to
do" from "the widget is broken". Both counts cover what you track:
`SEARCH_QUERY` and `IGNORE_REPOS` apply at the search, so the plugin never
fetches or counts what they exclude.

The pane takes no keyboard input, so you cannot type into it or kill it with a
keystroke. It **does** claim the mouse, in press/release SGR reporting only. The
original design left the mouse alone, and a measurement changed that. On iTerm2,
a ctrl-click, the modifier Herdr's link handling expects, never reaches the
terminal, because macOS claims it as the secondary click. A pane can act only on
the plain click, and it gets that click only by claiming the mouse. In exchange,
Herdr no longer resolves this pane's hyperlinks, so the pane opens them itself,
and only `http(s)` links. The pane derives its clickable spans from the painted
frame, so whatever carries a hyperlink responds to a click.

## Development

```bash
tests/run.sh    # everything below, and what CI runs
```

or the two halves on their own:

```bash
bun test        # no network, no gh, no Herdr
bunx tsc --noEmit
```

`tests/manifest.test.ts` is the one test file not about rendering. It checks the
manifest against the code it points at. A stale command path or an unmatched
link-handler pattern fails at runtime inside a hook, where nobody is watching.

The widget's design turns on one distinction: **draft modifies open.** A draft
is still open, still yours, and still needs you. It asks nobody else for anything
yet, so the pane dims it and keeps it.
