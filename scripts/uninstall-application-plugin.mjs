#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [pluginId] = process.argv.slice(2);
if (!/^[a-z][a-z0-9-]{0,62}$/.test(pluginId || "")) {
  process.stderr.write("usage: uninstall-application-plugin.mjs PLUGIN_ID\n");
  process.exit(2);
}
const stateRoot = process.env.HAWKSPAN_STATE_DIR
  ? path.resolve(process.env.HAWKSPAN_STATE_DIR)
  : path.join(os.homedir(), ".hawkspan");
const pluginRoot = path.join(stateRoot, "plugins");
const source = path.join(pluginRoot, pluginId);
if (!fs.existsSync(source)) throw new Error(`plugin is not installed: ${pluginId}`);
if (fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isDirectory()) {
  throw new Error("installed plugin path must be a non-symlink directory");
}
const archiveRoot = path.join(stateRoot, "uninstalled-plugins");
fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
const destination = path.join(archiveRoot, `${pluginId}-${Date.now()}`);
fs.renameSync(source, destination);
process.stdout.write(`${JSON.stringify({
  installed: false,
  plugin_id: pluginId,
  archived_at: destination,
})}\n`);
