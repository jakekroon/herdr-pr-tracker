// The manifest is the plugin's contract with Herdr: a typo in a command path
// or an action id fails at runtime, in a hook, where nobody is watching.
import { existsSync } from "node:fs";
import { VIEWS, viewUrl } from "../src/view.ts";

const manifest = Bun.TOML.parse(await Bun.file("herdr-plugin.toml").text()) as {
  id?: string;
  panes?: Array<{ id?: string; title?: string; command?: string[] }>;
  events?: Array<{ on?: string; command?: string[] }>;
  actions?: Array<{ id?: string; command?: string[] }>;
  startup?: Array<{ command?: string[] }>;
  link_handlers?: Array<{ id?: string; pattern?: string; action?: string }>;
};

const problems: string[] = [];
if (manifest.id !== "herdr-pr-tracker") problems.push(`unexpected id ${manifest.id}`);

const commands = [
  ...(manifest.panes ?? []),
  ...(manifest.events ?? []),
  ...(manifest.actions ?? []),
  ...(manifest.startup ?? []),
].map((e) => e.command ?? []);

for (const cmd of commands) {
  // Commands run directly, not through a shell, so `bun` must be explicit.
  if (cmd[0] !== "bun") problems.push(`command does not invoke bun: ${cmd.join(" ")}`);
  const script = cmd[1];
  if (!script || !existsSync(script)) problems.push(`missing script: ${script}`);
}

// Every pane entrypoint referenced from code must exist in the manifest.
const paneIds = new Set((manifest.panes ?? []).map((p) => p.id));
const follow = await Bun.file("bin/follow.ts").text();
const entrypoint = follow.match(/ENTRYPOINT = "([^"]+)"/)?.[1];
if (!entrypoint || !paneIds.has(entrypoint)) {
  problems.push(`follow opens entrypoint "${entrypoint}", which the manifest does not declare`);
}

// Adoption recognises the widget by the label Herdr derives from the pane's
// manifest `title`. Renaming the title without renaming WIDGET_LABEL would stop
// the widget being recognised, and the only symptom is a slow leak of orphan
// panes that nothing ever closes. The pane's *display title* changes with the
// view and is set through `report-metadata`, which leaves `label` alone — that
// is why this check is still about one constant name.
const widgetLabel = (await Bun.file("src/dock.ts").text())
  .match(/WIDGET_LABEL = "([^"]+)"/)?.[1];
const declaredTitle = (manifest.panes ?? []).find((p) => p.id === entrypoint)?.title;
if (!widgetLabel || widgetLabel !== declaredTitle) {
  problems.push(
    `adoption matches panes labelled "${widgetLabel}", but the manifest titles "${entrypoint}" as "${declaredTitle}"`,
  );
}

// One action changes the view, and it takes no argument: the toggle reads the
// current view and writes the other. An argument here would be a view name, and
// a mistyped one is a packaging bug nothing reports at runtime.
const viewActions = (manifest.actions ?? []).filter((a) =>
  (a.command ?? [])[1] === "bin/view.ts"
);
if (viewActions.length !== 1) {
  problems.push(`expected exactly one view action, found ${viewActions.length}`);
}
for (const a of viewActions) {
  const arg = (a.command ?? [])[2];
  if (arg != null && arg !== "toggle" && !VIEWS.includes(arg as never)) {
    problems.push(`action ${a.id} passes unknown view "${arg}"`);
  }
}

// The header's view switcher emits `viewUrl(view)` as an OSC 8 hyperlink, and
// Herdr only routes the click back to this plugin if a link handler's pattern
// matches it exactly. Nothing at runtime reports a miss: an unmatched URL falls
// through to the browser opener, so a drifted URL is a control that silently
// stops working. The pattern is therefore checked against the same function the
// renderer calls, and the action it fires against the one action that switches.
const viewActionIds = new Set(viewActions.map((a) => a.id));
for (const view of VIEWS) {
  const url = viewUrl(view);
  // `pattern` is a Rust regex, so it is tested by *matching*, not by comparing
  // strings: a literal that looks right and a regex that matches are different
  // claims, and only the second is what Herdr will do.
  const handler = (manifest.link_handlers ?? []).find((h) => {
    try {
      return h.pattern != null && new RegExp(h.pattern).test(url);
    } catch {
      problems.push(`link handler ${h.id} has an unparseable pattern: ${h.pattern}`);
      return false;
    }
  });
  if (!handler) {
    problems.push(`no link handler matches the switcher URL ${url}`);
    continue;
  }
  // Both URLs fire the same toggle: whichever list was ctrl-clicked is by
  // construction the view you are not in, so "the other one" is the right move
  // from either.
  if (!viewActionIds.has(handler.action)) {
    problems.push(
      `link handler ${handler.id} matches ${url} but fires "${handler.action}", which does not change the view`,
    );
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`manifest: ${p}`);
  process.exit(1);
}
console.log(
  `${manifest.id}: ${commands.length} commands, entrypoint "${entrypoint}" declared, ${(manifest.link_handlers ?? []).length} link handlers, widget label "${widgetLabel}"`,
);
