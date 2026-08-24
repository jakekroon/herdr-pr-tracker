// The manifest is the plugin's contract with Herdr: a typo in a command path
// or an action id fails at runtime, in a hook, where nobody is watching.
import { existsSync } from "node:fs";

const manifest = Bun.TOML.parse(await Bun.file("herdr-plugin.toml").text()) as {
  id?: string;
  panes?: Array<{ id?: string; title?: string; command?: string[] }>;
  events?: Array<{ on?: string; command?: string[] }>;
  actions?: Array<{ id?: string; command?: string[] }>;
  startup?: Array<{ command?: string[] }>;
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
// panes that nothing ever closes.
const widgetLabel = follow.match(/WIDGET_LABEL = "([^"]+)"/)?.[1];
const declaredTitle = (manifest.panes ?? []).find((p) => p.id === entrypoint)?.title;
if (!widgetLabel || widgetLabel !== declaredTitle) {
  problems.push(
    `follow adopts panes labelled "${widgetLabel}", but the manifest titles "${entrypoint}" as "${declaredTitle}"`,
  );
}

if (problems.length > 0) {
  for (const p of problems) console.error(`manifest: ${p}`);
  process.exit(1);
}
console.log(
  `${manifest.id}: ${commands.length} commands, entrypoint "${entrypoint}" declared, widget label "${widgetLabel}"`,
);
