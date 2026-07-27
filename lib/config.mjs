// Per-user state lives outside the repo: tokens, saved places, parser logs.
// Override the whole directory with DEAL_RADAR_HOME.

import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR =
  process.env.DEAL_RADAR_HOME ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "deal-radar");

export const configPath = (name) => join(CONFIG_DIR, name);
