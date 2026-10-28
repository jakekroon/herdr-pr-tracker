# herdr-pr-tracker

A [Herdr](https://herdr.dev) plugin that lists your open pull requests in a
widget on the right of the current tab. The plugin reads GitHub and does not
change a pull request.

The widget has two views. `My PRs` shows the pull requests that you opened, in
all repositories that you can see. `Awaiting Review` shows the pull requests
that wait for your review.

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

## Install

You need Herdr 0.8.0, `bun` 1.2 and `gh` 2.24, or later versions, and `git`
on your `PATH`. `gh auth status` must show no errors.

```bash
herdr plugin install jakekroon/herdr-pr-tracker
```

The widget opens on the next tab change. In a script, add `--yes`, because
Herdr asks you to confirm. To install one version, add `--ref <tag>`. To change
the plugin, link a checkout with `herdr plugin link <path>`.

### Show the pull request in the sidebar

The plugin can add a token to the sidebar row of the focused agent pane. The
token shows the pull request for the branch of that pane: `#21288 ✓`, or
`◌#21288 ✓` for a draft. Add `$pr` to the agent row in your Herdr config:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", "tab", "$pr"], ["agent"]]
```

The token replaces the `gh-pr` plugin.

## Read the list

The first line is a summary: the count, the number that need you, the view
control and the age of the data. Under each repository heading, a pull request
has two lines: the branch with its marks, then the number, title and age. Click
the title to open the pull request in your browser.

### Marks

The table gives the marks in priority order. The colour of a row is the colour
of its highest mark. Each mark has its own cell, so a high mark does not hide a
low mark.

| Mark | Nerd Font | Meaning | Colour |
|---|---|---|---|
| `⊘` | `no-entry` | A conflict stops the merge | red |
| `✗` in the review column | `x-circle` | The reviewer requests changes | red |
| `✗` in the check column | `x` | Checks fail. A cancelled check is not a failure | red |
| `⚑N` | `comment-discussion` | `N` review threads are open, also threads that you replied to | yellow |
| `◆` | `eye` | A required review is not done | magenta |
| `●` | `dot-fill` | Checks are in progress | blue |
| `✓` in the review column | `check-circle` | Approved | green |
| `✓` in the check column | `check` | Checks pass | green |
| no mark | | Ready for review | plain |
| `◌` | `git-pull-request-draft` | Draft. The row is dim, and a failed check is dim red | dim |
| `▪` | `git-branch` | A Herdr workspace has this branch open | dim |
| `◦` | `comment` | `Awaiting Review` only. Nobody asked for your review, but you are in the conversation | plain |
| `N` after a heading | | `My PRs` only. The number of pull requests in that repository that need you | the colour of the highest row |
| `⚠` below the list | `alert` | A bad entry in `config`. See `config.example` | yellow |
| `✓ all clear` | `checklist` | You have no open pull requests | green |
| `⟳` in the sidebar | `sync` | The plugin is updating the token | plain |

In `My PRs`, a bold row needs an action from you: a conflict, requested
changes, failed checks or open threads. The summary counts these rows as
`need you`.

### Order and overflow

`My PRs` shows the oldest first, by creation date. A status change does not move
a row.

If the list is too tall for the widget, each pull request goes to one line. The
title line goes, and the link moves to the branch. If the list is still too
tall, the widget removes the oldest rows. A `… +N older` row shows the number
that it removed.

The age in the summary shows when the data came from GitHub. The age is yellow
after two poll intervals. It is red when a poll fails, with the cause:
`auth failed`, `offline` or `rate limited`.

## Change the view

Click `toggle` in the summary line. In a narrow widget the control is `⇄`. In a
very narrow widget there is no control, so use the `view-toggle` action. The
widget keeps your view after a restart.

| | `My PRs` | `Awaiting Review` |
|---|---|---|
| Shows | Pull requests that you opened | Pull requests where someone asked for your review, you gave a review, or you are in the conversation |
| Row starts with | The branch | The author, then the branch if there is space |
| Order | Oldest first | Newest first |
| Bold and `need you` | Yes | No. All rows need you |
| Colour priority | Conflict, changes requested, failed checks, open threads, review required, checks in progress, approved, clean | Conflict, review required, checks in progress, clean, open threads, failed checks, approved, changes requested |

GitHub removes a review request when you give your review. `Awaiting Review`
keeps these pull requests, so you can see the next step.

## Control the widget

| Action | Result |
|---|---|
| `herdr-pr-tracker.toggle` | Opens or closes the widget |
| `herdr-pr-tracker.refresh` | Gets the data from GitHub now |
| `herdr-pr-tracker.view-toggle` | Changes the view. Opens the widget if it is closed |

Run an action with `herdr plugin action invoke <action>`. The widget does not
accept keyboard input.

A plugin cannot add a keybinding. To use a key, add it to
`~/.config/herdr/config.toml`, then run `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+p"
type = "plugin_action"
command = "herdr-pr-tracker.toggle"
description = "toggle the PR pane"
```

Do not use `alt+` keys, because they type characters in the terminal. Do not use
`o`, `g`, `r`, `v` or `e`, because Herdr uses them.

## Configure

The plugin works with no config. To change a setting, copy `config.example` to
`config` in `herdr plugin config-dir herdr-pr-tracker`. `config.example` gives
each setting, its default and the mistakes that fail with no error.

The widget reads `config` only when it starts, and a plugin reload does not
restart it. After a change, close the widget with
`herdr plugin pane close <pane-id>`. `herdr pane list` shows its id with the
label `prs`. The widget opens again on the next tab change.

You cannot change the signal order, the sort order or the meaning of a mark.

### Use Nerd Font marks

Most monospace fonts do not have the default marks, so the OS draws them from
different fonts. `GLYPHS=nerd` uses GitHub's Octicons instead (see
[Marks](#marks)). The review mark and the check mark are then different. You
need a font with the Octicons:

| Terminal | Font |
|---|---|
| Ghostty | No action. Ghostty contains Symbols Nerd Font 3.4.0 |
| iTerm2 | `brew install --cask font-symbols-only-nerd-font`, then Profiles → Text → "Use a different font for non-ASCII text" |
| Other | A patched [Nerd Font](https://www.nerdfonts.com) as the terminal font |

If a cell is blank, the font does not have the mark.

## Uninstall

Close the widget before you remove the plugin. Herdr does not stop the widget
process when you remove the plugin, and the process continues to poll GitHub.

1. Close the widget: `herdr plugin action invoke herdr-pr-tracker.toggle`.
2. Run `herdr pane list`. If a `prs` pane is there, close it with
   `herdr pane close <pane-id>`. This also stops a widget left after an
   uninstall.
3. Remove the plugin: `herdr plugin uninstall herdr-pr-tracker`. For a linked
   checkout, use `unlink`.

The uninstall keeps your config, widths, view and cache. To remove them, delete
the `herdr plugin config-dir herdr-pr-tracker` directory and the plugin
directory in `~/.local/state/herdr/plugins`.

## Limits

- **The widget does not show "behind the base branch".** GitHub reports one
  merge state at a time, and another state can hide "behind".
- **A new conflict can show one poll late.** GitHub calculates mergeability
  after a delay, and the widget shows an unknown state as no conflict.
- **Each poll costs rate limit.** One `gh api graphql` request gets the full
  view. `My PRs` costs 5 points and `Awaiting Review` costs 15. At the default
  60-second poll, that is 300 or 900 of the 5000-point hourly limit.
- **The widget polls only while it is open.** Herdr does not run background
  jobs for plugins, so the poll runs in the widget process.
- **The widget opens links itself.** On iTerm2, Herdr does not get a
  ctrl-click, so the widget reads the plain click and opens `http(s)` links.

## Development

```bash
tests/run.sh   # all tests and the typecheck, with no network. CI runs this.
```

`tests/manifest.test.ts` compares the manifest with the code. A bad command path
or link pattern otherwise fails in a hook at runtime, where you cannot see the
error.
