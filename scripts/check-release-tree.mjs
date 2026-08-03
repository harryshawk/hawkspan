#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReleaseManifest, RELEASE_MANIFEST_PATH, verifyReleaseTree } from "./release-tree.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.slice(2).includes("--write");

try {
  if (write) {
    const manifest = createReleaseManifest(repository);
    const target = path.join(repository, RELEASE_MANIFEST_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    process.stdout.write(`wrote ${RELEASE_MANIFEST_PATH} (${manifest.release_id})\n`);
  } else {
    const result = verifyReleaseTree(repository);
    process.stdout.write(`hawkspan exact release tree verified (${result.file_count} files; ${result.release_id})\n`);
  }
} catch (error) {
  process.stderr.write(`release tree verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
