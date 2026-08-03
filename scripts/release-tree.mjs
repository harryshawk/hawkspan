#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RELEASE_MANIFEST_PATH = "release/release-manifest.json";
const RELEASE_KIND = "hawkspan-public-release-tree";
const RELEASE_ID_PATTERN = /^tree-sha256:[a-f0-9]{64}$/;

function normalizedPath(value) {
  return value.split(path.sep).join("/");
}

function isGeneratedPythonBytecode(portable) {
  return portable.split("/").includes("__pycache__") || portable.endsWith(".pyc");
}

function walk(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const files = [];
  for (const entry of entries) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    const portable = normalizedPath(child);
    if (portable === ".git" || portable.startsWith(".git/")) continue;
    if (portable === RELEASE_MANIFEST_PATH) continue;
    if (isGeneratedPythonBytecode(portable)) continue;
    const target = path.join(root, child);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`release tree contains unsupported entry: ${portable}`);
    }
    if (stat.isDirectory()) files.push(...walk(root, child));
    else files.push({
      path: portable,
      size: stat.size,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
    });
  }
  return files;
}

function releaseId(files) {
  const digest = crypto.createHash("sha256");
  for (const file of files) {
    digest.update(file.path, "utf8");
    digest.update("\0");
    digest.update(String(file.size), "utf8");
    digest.update("\0");
    digest.update(file.sha256, "ascii");
    digest.update("\n");
  }
  return `tree-sha256:${digest.digest("hex")}`;
}

export function createReleaseManifest(root) {
  const files = walk(path.resolve(root))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    schema_version: 1,
    kind: RELEASE_KIND,
    release_id: releaseId(files),
    files,
  };
}

export function readReleaseManifest(root) {
  const target = path.join(path.resolve(root), RELEASE_MANIFEST_PATH);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error("invalid release manifest file");
  }
  const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
  const keys = Object.keys(manifest).sort().join("\0");
  if (keys !== ["files", "kind", "release_id", "schema_version"].join("\0") ||
      manifest.schema_version !== 1 || manifest.kind !== RELEASE_KIND ||
      !RELEASE_ID_PATTERN.test(manifest.release_id) || !Array.isArray(manifest.files)) {
    throw new Error("invalid release manifest content");
  }
  let previous = "";
  for (const file of manifest.files) {
    if (!file || Object.keys(file).sort().join("\0") !== "path\0sha256\0size" ||
        typeof file.path !== "string" || file.path.length === 0 || file.path.startsWith("/") ||
        file.path.includes("\\") || file.path.split("/").includes("..") ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256) || file.path <= previous) {
      throw new Error("invalid release manifest entry");
    }
    previous = file.path;
  }
  return manifest;
}

export function verifyReleaseTree(root) {
  const expected = readReleaseManifest(root);
  const actual = createReleaseManifest(root);
  if (JSON.stringify(actual.files) !== JSON.stringify(expected.files) ||
      actual.release_id !== expected.release_id) {
    throw new Error("release tree does not match its manifest");
  }
  return Object.freeze({ release_id: expected.release_id, file_count: expected.files.length });
}
