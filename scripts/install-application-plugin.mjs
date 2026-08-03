#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePluginDirectory } from "./application-plugins.mjs";

const [sourceArgument] = process.argv.slice(2);
if (!sourceArgument) {
  process.stderr.write("usage: install-application-plugin.mjs PLUGIN_DIRECTORY\n");
  process.exit(2);
}

const stateRoot = process.env.HAWKSPAN_STATE_DIR
  ? path.resolve(process.env.HAWKSPAN_STATE_DIR)
  : path.join(os.homedir(), ".hawkspan");
const source = path.resolve(sourceArgument);
const validated = validatePluginDirectory(source, path.dirname(source));
const pluginRoot = path.join(stateRoot, "plugins");
fs.mkdirSync(pluginRoot, { recursive: true, mode: 0o700 });
const destination = path.join(pluginRoot, validated.manifest.id);
if (fs.existsSync(destination)) {
  throw new Error(`plugin is already installed: ${validated.manifest.id}`);
}
const stagingContainer = path.join(pluginRoot, `.install-${validated.manifest.id}-${process.pid}`);
const staging = path.join(stagingContainer, validated.manifest.id);
try {
  fs.mkdirSync(stagingContainer, { mode: 0o700 });
  fs.cpSync(source, staging, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    filter(candidate) {
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        throw new Error(`symbolic links are not allowed in plugins: ${candidate}`);
      }
      return true;
    },
  });
  validatePluginDirectory(staging, stagingContainer);
  fs.renameSync(staging, destination);
  fs.rmdirSync(stagingContainer);
  process.stdout.write(`${JSON.stringify({
    installed: true,
    plugin_id: validated.manifest.id,
    destination,
  })}\n`);
} catch (error) {
  fs.rmSync(stagingContainer, { recursive: true, force: true });
  throw error;
}
