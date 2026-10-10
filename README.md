# herdr-pr-tracker

A [Herdr](https://herdr.dev) plugin. It shows **all open pull requests that you
wrote**, from all repositories you can see. The list docks on the right of the
current tab.

The plugin only tracks. It does not open, close, merge or comment on a pull
request.

A second view shows the pull requests that **wait for your review**. The widget
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

The first line is a summary. Each repository has a heading. Each pull request
has two lines:

1. The branch and its status marks.
2. The number, the title and the age of the pull request.

**The title is a link.** Click it to open the pull request in your browser.

## Marks

| Mark | Meaning | Colour |
|---|---|---|
| `⊘` | A conflict stops the merge | red |
| `✗` in the review column | The reviewer requests changes | red |
| `✗` in the check column | Checks fail | red |
| `⚑N` | `N` review threads are open | yellow |
| `◆` | A required review is not done | magenta |
| `●` | Checks are in progress | blue |
| `✓` in the review column | Approved | green |
| `✓` in the check column | Checks pass | green |
| `◌` | Draft. The row is dim | dim |
| **bold** branch | `My PRs` only. A conflict, requested changes, failed checks or open threads. You must act on these four | none |
| `▪` | A Herdr workspace has this branch open | dim |
| `◦` | `Awaiting Review` only. You are in the conversation, but nobody asked for your review | plain |
| `N` after a repository heading | `My PRs` only. The number of pull requests in that repository that need you | the loudest colour of those rows |
| no mark | Ready for review. No action | plain |
| `⚠` below the list | A `config` error. See [Configuration](#configuration) | yellow |

One pull request can show many marks. Each mark has its own cell, so a loud mark
does not hide a quiet mark.

The row colour is the colour of its loudest mark. The order is: conflict,
changes requested, failed checks, open threads, review required, checks in
progress, approved, clean.

### Nerd Font marks

Most monospace fonts do not have these marks. Monaco, the macOS default, has
one of the eleven (`◆`). The OS draws the other ten from different fonts, so the
marks can look different.

`GLYPHS=nerd` uses [Octicons](https://primer.style/octicons/), the GitHub icon
set. The cells, widths and meanings do not change. The review result and the
check result also get different marks. The default set uses `✓` for both.

Add this line to `config`:

```
GLYPHS=nerd
```

The plugin reads two `config` files: the copy beside the plugin
(`cp config.example config`), then the copy in
`herdr plugin config-dir herdr-pr-tracker`. The second file wins.

To go back, set `GLYPHS=unicode` or delete the line. Use lower case. The plugin
ignores other values and uses the default.

| Mark | Octicon | | Mark | Octicon |
|---|---|---|---|---|
| conflict | `no-entry` | | draft | `git-pull-request-draft` |
| changes requested | `x-circle` | | workspace open | `git-branch` |
| checks fail | `x` | | in the conversation | `comment` |
| open threads | `comment-discussion` | | checks in progress | `dot-fill` |
| review required | `eye` | | approved | `check-circle` |
| config error | `alert` | | checks pass | `check` |
| no open pull requests | `checklist` | | sidebar update | `sync` |

You need a font with these marks:

| Ghostty | No action. Ghostty contains Symbols Nerd Font 3.4.0 |
|---|---|
| **iTerm2** | `brew install --cask font-symbols-only-nerd-font`, then Profiles → Text → "Use a different font for non-ASCII text" |
| **Other terminals** | Use a patched [Nerd Font](https://www.nerdfonts.com) as the terminal font |

The widget reads `config` one time, when it starts. A plugin reload does not
restart it. After you change `GLYPHS`, close the widget:

```sh
herdr plugin pane close <pane-id>   # the id from `herdr pane list`
```

The widget opens again on the next tab change. If the font does not have a
mark, the cell is blank. Look at the widget to make sure the marks show.

### Rules for colour and marks

- **A clean pull request has no colour.** If all rows have colour, the colour
  gives no information.
- **Bold shows your work.** Your action clears four signals: a conflict,
  requested changes, failed checks and open threads. These four are bold. The
  summary counts them as `need you`.
- **A conflict is first in both views.** The review and the checks do not
  matter until the conflict is gone. Each row keeps a column for the conflict
  mark, so the marks stay aligned.
- **An unknown conflict shows no mark.** GitHub calculates mergeability after a
  delay. A conflict can show one poll after its row.
- **The widget does not show "behind the base branch".** GitHub reports only one
  merge state at a time. That state hides "behind" when another state is also
  true.
- **A cancelled check is not a failure.** A new push cancels most of these runs.
- **Checks in progress are blue, not green.** Green means the checks passed.
- **A draft is dim.** A failed check on a draft shows in dim red.
- **All open threads count.** This includes threads that you replied to. The
  widget shows the GitHub count and does not guess who must act next.
- **`▪` shows which branches you have checked out.** The GitHub list cannot
  show this.

### Order and overflow

The list shows the **oldest first**, by creation date. A status change does not
move a row.

If the list is too tall for the widget, **each pull request goes to one line**.
The widget removes the title line and puts the link on the branch.

If one line for each pull request is also too tall, the widget removes the
oldest rows. A `… +N older` row shows how many it removed. This row is next to
the rows that it replaces.

## Two views

The widget title shows the view:

| Title | Shows |
|---|---|
| `My PRs` | The pull requests that you opened. This is the default. The code calls it the *authored* view. |
| `Awaiting Review` | The pull requests that wait for you. Someone asked for your review, you gave a review, or you are in the conversation. The code calls it the *inbound* view. |

**Click `toggle` in the summary line** to change the view. No setup is
necessary. In a narrow widget, the control is `⇄`. In a very narrow widget, the
control is not there.

A click on a pull request opens it in the browser. You can also change the view
with `herdr plugin action invoke` or with a keybinding (see
[Keybindings](#keybindings)).

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

In the inbound view, the work belongs to another person. Thus:

- **Each row starts with the author.** The branch comes after the author if
  there is space.
- **`◦` shows a row that nobody asked you to review.** Someone assigned you,
  mentioned you, or you wrote a comment.
- **The colour order is different.** The order is: conflict, review required,
  checks in progress, clean, open threads, failed checks, approved, changes
  requested. A conflict is first because you cannot review it. Requested changes
  are last because they are usually your own result. Failed checks and open
  threads are the work of the author.
- **There is no `need you` count and no bold.** All rows in this view need you.
- **The list shows the newest first.** GitHub removes a review request after you
  review. Thus the view also shows pull requests that you reviewed, so that you
  can see the next step. The oldest rows are the pull requests that you
  completed. The widget removes these first.

The plugin keeps your view after a restart. Each view has its own cache.

## Sidebar token

The plugin adds a token to the sidebar row of the focused agent pane. The token
shows the pull request for the branch of that pane:
`#21288 ✓`, or `◌#21288 ✓` for a draft. To show it, add `$pr` to the agent row:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", "tab", "$pr"], ["agent"]]
```

This token replaces the `gh-pr` plugin.

## Requirements

- Herdr 0.8.0 or later
- `bun` 1.2 or later
- `gh` 2.24 or later. `gh auth status` must show no errors
- `git` on your `PATH`

## Install

```bash
herdr plugin install jakekroon/herdr-pr-tracker
```

There is no daemon, no config file and no build step.

Herdr asks you to confirm the install. A script has no terminal to answer, so
add `--yes`:

```bash
herdr plugin install jakekroon/herdr-pr-tracker --yes
```

To use one version, add `--ref`:

```bash
herdr plugin install jakekroon/herdr-pr-tracker --ref v0.5.1
```

To change the plugin, link a local checkout:

```bash
herdr plugin link /path/to/herdr-pr-tracker
```

### Uninstall

**Close the widget before you remove the plugin.** If you remove the plugin
first, the widget process continues to run:

```bash
herdr plugin action invoke herdr-pr-tracker.toggle   # closes the widget
herdr plugin uninstall herdr-pr-tracker              # or: unlink, for a checkout
```

After the uninstall, Herdr does not stop the widget process. The process
continues to ask GitHub for your pull requests each minute.
`herdr plugin pane close` cannot find the widget then.

To close a widget that stays after an uninstall, use the usual pane command.
The widget has the label `prs`:

```bash
herdr pane list | grep prs
herdr pane close <pane-id>
```

The uninstall keeps the config and state directories. A new install uses your
widths, your view and your cache again. To start again with no data, delete
these two directories:

- `herdr plugin config-dir herdr-pr-tracker`
- the plugin directory in `~/.local/state/herdr/plugins`

### Keybindings

A plugin cannot add a keybinding. To use a key for an action, add it to
`~/.config/herdr/config.toml`. Then run `herdr server reload-config`:

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

`view-toggle` also opens the widget when it is not on the screen.

Do not use `alt+` keys. They type characters in the terminal. Do not use `o`,
`g`, `r`, `v` or `e`. Herdr uses these keys.

## Configuration

The config is optional. Run `cp config.example config`, or put a `config` in
`herdr plugin config-dir herdr-pr-tracker`. The second file wins.
`config.example` gives all settings. You can use quotes on values.

The widget reads `config` one time, when it starts. After a change, toggle the
widget off and on.

### `SEARCH_QUERY`

`SEARCH_QUERY` sets the GitHub search for the authored view. It has no effect on
the inbound view. The inbound view uses three fixed searches to find the `◦`
rows.

### `IGNORE_REPOS`

`IGNORE_REPOS` gives repositories and owners that the widget does not get, in
**both** views:

```
IGNORE_REPOS="acme/web-app acme/"
```

- `acme/web-app` is one repository.
- `acme/` is all repositories of one owner.
- Use spaces or commas between entries.
- Case has no effect: `Acme/Web-App` and `acme/web-app` are one entry.

**Each entry must have a slash.** The plugin ignores an entry without a slash,
such as `web-app`. GitHub accepts that entry, removes nothing and gives no
error.

For ignored entries, the widget shows `⚠ 2 bad IGNORE_REPOS entries` below the
list. To find the bad entries, run `bun bin/pane.ts` in a terminal. It writes
their names to stderr.

The `⚠` line shows the config from when the widget started. After you correct
an entry, restart the widget.

The search removes ignored repositories before the widget gets the data. Thus,
there is no "N ignored" count. `0 open` and `✓ all clear` apply only to what you
track.

### `MAX_IDLE_DAYS`

`MAX_IDLE_DAYS` hides pull requests with no update for that number of days, in
**both** views:

```
MAX_IDLE_DAYS=30
```

An update is a change to the GitHub `updated` date. A comment, a push, a review,
a label, a bot or a CI result is an update. The age on the row is the time since
the pull request opened. There is no "N hidden" count. If you do not set it, or
set it to `0`, there is no limit.

### Fixed behaviour

You cannot change the signal order, the sort order or what a mark means. With
such a setting, you must remember it before you can read the list. `GLYPHS` and
`COLOR` change only how the terminal draws the marks.

## How it works

Each poll sends one `gh api graphql` request. The request gets all pull requests
and their data.

GitHub calculates the rate-limit cost for each `search` field. The authored
view costs **5 points** for each poll. The inbound view has three searches and
costs **15 points**. At the default 60-second poll, this is a small part of the
5000-point hourly limit. Each response contains `rateLimit { cost remaining }`.

The plugin uses GraphQL because only GraphQL gives `isResolved` for review
threads.

Herdr does not run background jobs for plugins. Thus, the poll loop runs in the
widget process. When you change tabs, the plugin moves the widget. The list stays
on the screen during the move.

The summary shows the age of the data:

- After two poll intervals, the age is yellow.
- If a poll fails, the age is red. The summary gives the cause: `auth failed`,
  `offline` or `rate limited`.
- An empty list shows `0 open` (or `0 inbound`) and `✓ all clear`.

The widget does not accept keyboard input. It reads the mouse with SGR
press/release reports.

On iTerm2, macOS uses ctrl-click for its own menu. Thus, a ctrl-click does not
get to Herdr. The widget must read the mouse to get the plain click. Herdr then
does not open the links in the widget. The widget opens `http(s)` links itself.

## Development

```bash
tests/run.sh    # all tests and the typecheck. CI runs this.
```

Or run the two parts:

```bash
bun test        # no network, no gh, no Herdr
bunx tsc --noEmit
```

`tests/manifest.test.ts` compares the manifest with the code. A bad command path
or link pattern fails in a hook at runtime, where you cannot see the error.

A draft is open. It is still your work, so the widget shows it dim and does not
remove it.
