#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertProductSeparated } from "./product-separation.mjs";
import { assertSourceLineage, createReleaseProvenance } from "./source-authority.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.dirname(scriptRoot);
const outputIndex = process.argv.indexOf("--output-root");
const remoteIndex = process.argv.indexOf("--published-remote");
const refIndex = process.argv.indexOf("--published-ref");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  throw new Error("--output-root requires a path");
}
if (remoteIndex < 0 || !process.argv[remoteIndex + 1] ||
    refIndex < 0 || !process.argv[refIndex + 1]) {
  throw new Error("--published-remote and --published-ref are required");
}
const outputRoot = path.resolve(process.argv[outputIndex + 1]);
const publishedRemote = process.argv[remoteIndex + 1];
const publishedRef = process.argv[refIndex + 1].startsWith("refs/")
  ? process.argv[refIndex + 1]
  : `refs/heads/${process.argv[refIndex + 1]}`;
const lineage = assertSourceLineage(sourceRoot, { requireClean: true });
assertProductSeparated(sourceRoot);
const publishedRepositoryResult = spawnSync(
  "git", ["-C", sourceRoot, "remote", "get-url", publishedRemote], { encoding: "utf8" },
);
if (publishedRepositoryResult.status !== 0) {
  throw new Error(`published remote is unavailable: ${publishedRemote}`);
}
const publishedRepository = publishedRepositoryResult.stdout.trim();
const remoteRevision = spawnSync(
  "git", ["ls-remote", "--refs", publishedRepository, publishedRef], { encoding: "utf8" },
);
if (remoteRevision.error) throw remoteRevision.error;
if (remoteRevision.status !== 0) {
  throw new Error(`cannot verify published ref ${publishedRemote}/${publishedRef}`);
}
const publishedSha = remoteRevision.stdout.trim().split(/\s+/)[0] || "";
if (publishedSha !== lineage.revision) {
  throw new Error(
    `published ref ${publishedRemote}/${publishedRef} is ${publishedSha || "missing"}, ` +
    `not candidate ${lineage.revision}`,
  );
}
const destination = path.join(
  outputRoot,
  `hawkspan-${lineage.authority.release_version}-${lineage.revision.slice(0, 12)}`,
);
if (fs.existsSync(destination)) throw new Error(`release destination already exists: ${destination}`);
fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
const temporary = `${destination}.tmp-${process.pid}`;
fs.mkdirSync(temporary, { mode: 0o700 });
try {
  const archive = spawnSync("git", ["-C", sourceRoot, "archive", "--format=tar", lineage.revision], {
    maxBuffer: 128 * 1024 * 1024,
  });
  if (archive.error) throw archive.error;
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr.toString().trim()}`);
  const extract = spawnSync("tar", ["-xf", "-", "-C", temporary], { input: archive.stdout });
  if (extract.error) throw extract.error;
  if (extract.status !== 0) throw new Error(`tar extraction failed: ${extract.stderr.toString().trim()}`);
  createReleaseProvenance(temporary, {
    revision: lineage.revision,
    tree: lineage.tree,
    sourceAuthority: lineage.authority,
    publishedRepository,
    publishedRef,
  });
  assertProductSeparated(temporary);
  fs.renameSync(temporary, destination);
} catch (error) {
  fs.rmSync(temporary, { recursive: true, force: true });
  throw error;
}
process.stdout.write(`${JSON.stringify({
  packaged: true,
  revision: lineage.revision,
  tree: lineage.tree,
  release_root: destination,
  published_repository: publishedRepository,
  published_ref: publishedRef,
}, null, 2)}\n`);
