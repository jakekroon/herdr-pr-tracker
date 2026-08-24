// Configuration is deliberately small. Glyphs, colours, precedence and sort
// order are not configurable: a widget whose meaning depends on settings is a
// widget you have to remember the settings of before you can read it.

import { join } from "node:path";
import { DEFAULT_SEARCH } from "./query.ts";

export interface Config {
  pollSeconds: number;
  searchQuery: string;
  maxPrs: number;
  /** "auto" shows the owner only when a PR's owner is not the common one. */
  showOwner: "auto" | "always" | "never";
  colour: boolean;
  /** Minimum seconds between per-pane sidebar-token lookups. */
  tokenThrottleSeconds: number;
}

export const DEFAULTS: Config = {
  pollSeconds: 60,
  searchQuery: DEFAULT_SEARCH,
  maxPrs: 100,
  showOwner: "auto",
  colour: true,
  tokenThrottleSeconds: 30,
};

/** Parse `KEY=value` lines. Shell-shaped so the file is interchangeable with
 * the `config`/`config.example` convention the sibling plugin established. */
export function parseConfig(text: string): Partial<Config> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    out[key] = value;
  }

  const cfg: Partial<Config> = {};
  const int = (v: string | undefined, min: number) => {
    if (v == null) return undefined;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= min ? n : undefined;
  };

  const poll = int(out.POLL_SECONDS, 5);
  if (poll != null) cfg.pollSeconds = poll;
  const max = int(out.MAX_PRS, 1);
  if (max != null) cfg.maxPrs = Math.min(max, 100);
  const throttle = int(out.TOKEN_THROTTLE_SECONDS, 0);
  if (throttle != null) cfg.tokenThrottleSeconds = throttle;
  if (out.SEARCH_QUERY) cfg.searchQuery = out.SEARCH_QUERY;
  if (out.SHOW_OWNER === "always" || out.SHOW_OWNER === "never" || out.SHOW_OWNER === "auto") {
    cfg.showOwner = out.SHOW_OWNER;
  }
  if (out.COLOR != null || out.COLOUR != null) {
    const v = (out.COLOR ?? out.COLOUR)!.toLowerCase();
    cfg.colour = !(v === "0" || v === "off" || v === "false" || v === "no");
  }
  return cfg;
}

/**
 * Read the repo-root `config` first, then the plugin config dir — the second
 * wins, so a linked development checkout can be overridden by the installed
 * config without editing the tree.
 */
export async function loadConfig(pluginRoot: string, configDir?: string): Promise<Config> {
  let cfg: Config = { ...DEFAULTS };
  for (const dir of [pluginRoot, configDir]) {
    if (!dir) continue;
    const file = Bun.file(join(dir, "config"));
    if (!(await file.exists())) continue;
    cfg = { ...cfg, ...parseConfig(await file.text()) };
  }
  return cfg;
}
