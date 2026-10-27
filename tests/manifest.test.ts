// A typo in a command path or action id fails at runtime, inside a hook.
// Keep the `.test.ts` suffix: `bun test` discovers nothing else.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { VIEWS, viewUrl } from "../src/view.ts";

const manifest = Bun.TOML.parse(await Bun.file("herdr-plugin.toml").text()) as {
  id?: string;
  version?: string;
  panes?: Array<{ id?: string; title?: string; command?: string[] }>;
  events?: Array<{ on?: string; command?: string[] }>;
  actions?: Array<{ id?: string; command?: string[] }>;
  startup?: Array<{ command?: string[] }>;
  link_handlers?: Array<{ id?: string; pattern?: string; action?: string }>;
};

const problems: string[] = [];
if (manifest.id !== "herdr-pr-tracker") problems.push(`unexpected id ${manifest.id}`);

// Herdr reports the manifest's version, so a stale manifest ships a release
// that names itself the previous version.
const pkgVersion = (JSON.parse(await Bun.file("package.json").text()) as { version?: string })
  .version;
if (manifest.version !== pkgVersion) {
  problems.push(`version mismatch: manifest ${manifest.version} vs package.json ${pkgVersion}`);
}

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

const paneIds = new Set((manifest.panes ?? []).map((p) => p.id));
const follow = await Bun.file("bin/follow.ts").text();
const entrypoint = follow.match(/ENTRYPOINT = "([^"]+)"/)?.[1];
if (!entrypoint || !paneIds.has(entrypoint)) {
  problems.push(`follow opens entrypoint "${entrypoint}", which the manifest does not declare`);
}

// Herdr derives the pane label from the manifest `title`, and adoption matches
// on it. A mismatch with WIDGET_LABEL leaks orphan panes with no other symptom.
const widgetLabel = (await Bun.file("src/dock.ts").text())
  .match(/WIDGET_LABEL = "([^"]+)"/)?.[1];
const declaredTitle = (manifest.panes ?? []).find((p) => p.id === entrypoint)?.title;
if (!widgetLabel || widgetLabel !== declaredTitle) {
  problems.push(
    `adoption matches panes labelled "${widgetLabel}", but the manifest titles "${entrypoint}" as "${declaredTitle}"`,
  );
}

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

// Herdr routes a click back to the plugin only if a link handler's pattern
// matches `viewUrl(view)`. A miss falls through to the browser with no error.
const viewActionIds = new Set(viewActions.map((a) => a.id));
for (const view of VIEWS) {
  const url = viewUrl(view);
  // `pattern` is a Rust regex, so match it against the URL.
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
  // Both URLs fire the toggle: a clicked list is always the other view.
  if (!viewActionIds.has(handler.action)) {
    problems.push(
      `link handler ${handler.id} matches ${url} but fires "${handler.action}", which does not change the view`,
    );
  }
}

test("the manifest matches the code it points at", () => {
  expect(problems).toEqual([]);
});

// An empty manifest would pass every check above.
test("the manifest declares the commands and handlers the plugin needs", () => {
  expect(commands.length).toBeGreaterThan(0);
  expect(commands.every((c) => c.length >= 2)).toBe(true);
  expect(manifest.link_handlers?.length).toBe(VIEWS.length);
  expect(widgetLabel).toBeTruthy();
  expect(entrypoint).toBeTruthy();
});
