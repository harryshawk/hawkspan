import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const PROVENANCE_NAME = ".hawkspan-release-provenance.json";

function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

function normalizeRepository(value) {
  return String(value || "")
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function walkFiles(root, relative = "") {
  const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (!relative && [".git", PROVENANCE_NAME].includes(entry.name)) continue;
    const full = path.join(root, child);
    if (entry.isSymbolicLink()) throw new Error(`release provenance refuses symbolic link: ${child}`);
    if (entry.isDirectory()) files.push(...walkFiles(root, child));
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
    else throw new Error(`release provenance refuses non-regular entry: ${child}`);
  }
  return files;
}

export function readSourceAuthority(root) {
  const authorityPath = path.join(root, "config", "source-authority.json");
  const authority = readJson(authorityPath);
  if (authority.schema_version !== 1 ||
      !/^\d+\.\d+\.\d+$/.test(String(authority.release_version || "")) ||
      !authority.canonical_repository || authority.production_branch !== "main" ||
      !authority.staging_repository ||
      !SHA_PATTERN.test(String(authority.required_public_ancestor || ""))) {
    throw new Error("source authority is incomplete");
  }
  return Object.freeze(authority);
}

export function assertSourceLineage(root, { requireClean = true } = {}) {
  const releaseRoot = fs.realpathSync(root);
  const authority = readSourceAuthority(releaseRoot);
  const repositoryRoot = git(releaseRoot, ["rev-parse", "--show-toplevel"]).stdout.trim();
  if (fs.realpathSync(repositoryRoot) !== releaseRoot) {
    throw new Error("release root must be the Git repository root");
  }
  const revision = git(releaseRoot, ["rev-parse", "HEAD"]).stdout.trim();
  if (!SHA_PATTERN.test(revision)) throw new Error("Git HEAD is not an exact commit SHA");
  const tree = git(releaseRoot, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
  const ancestor = git(releaseRoot, [
    "merge-base", "--is-ancestor", authority.required_public_ancestor, revision,
  ], { allowFailure: true });
  if (ancestor.status !== 0) {
    throw new Error(
      `candidate ${revision} does not descend from required public ancestor ` +
      authority.required_public_ancestor,
    );
  }
  const origin = git(releaseRoot, ["remote", "get-url", "origin"]).stdout.trim();
  const allowedRepositories = [authority.canonical_repository, authority.staging_repository]
    .map(normalizeRepository);
  if (!allowedRepositories.includes(normalizeRepository(origin))) {
    throw new Error(`origin is not an authorized HawkSpan repository: ${origin}`);
  }
  const plugin = readJson(path.join(releaseRoot, ".codex-plugin", "plugin.json"));
  if (plugin.version !== authority.release_version) {
    throw new Error(
      `plugin version ${plugin.version} does not match source authority ${authority.release_version}`,
    );
  }
  if (requireClean) {
    const dirty = git(releaseRoot, ["status", "--porcelain", "--untracked-files=all"]).stdout.trim();
    if (dirty) throw new Error("release source must be committed and clean");
  }
  return Object.freeze({ revision, tree, origin, authority });
}

export function createReleaseProvenance(releaseRoot, {
  revision,
  tree,
  sourceAuthority,
  publishedRepository,
  publishedRef,
}) {
  if (!SHA_PATTERN.test(String(revision || "")) || !SHA_PATTERN.test(String(tree || ""))) {
    throw new Error("release provenance requires exact commit and tree SHAs");
  }
  const allowedRepositories = [
    sourceAuthority.canonical_repository,
    sourceAuthority.staging_repository,
  ].map(normalizeRepository);
  if (!allowedRepositories.includes(normalizeRepository(publishedRepository)) ||
      !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(String(publishedRef || ""))) {
    throw new Error("release provenance requires an authorized published branch");
  }
  const files = Object.fromEntries(walkFiles(releaseRoot).map((relativePath) => {
    const fullPath = path.join(releaseRoot, relativePath);
    const stat = fs.statSync(fullPath);
    return [relativePath, {
      sha256: sha256(fullPath),
      size: stat.size,
      executable: (stat.mode & 0o111) !== 0,
    }];
  }));
  const provenance = {
    schema_version: 1,
    revision,
    tree,
    release_version: sourceAuthority.release_version,
    canonical_repository: sourceAuthority.canonical_repository,
    required_public_ancestor: sourceAuthority.required_public_ancestor,
    published_repository: publishedRepository,
    published_ref: publishedRef,
    files,
  };
  fs.writeFileSync(
    path.join(releaseRoot, PROVENANCE_NAME),
    `${JSON.stringify(provenance, null, 2)}\n`,
    { mode: 0o444, flag: "wx" },
  );
  return Object.freeze(provenance);
}

export function verifyPackagedRelease(releaseRoot, revision) {
  if (!SHA_PATTERN.test(String(revision || ""))) {
    throw new Error("revision must be an exact 40-character Git commit SHA");
  }
  const provenancePath = path.join(releaseRoot, PROVENANCE_NAME);
  if (!fs.existsSync(provenancePath) || fs.lstatSync(provenancePath).isSymbolicLink()) {
    throw new Error(`packaged release provenance is missing: ${provenancePath}`);
  }
  const provenance = readJson(provenancePath);
  const authority = readSourceAuthority(releaseRoot);
  if (provenance.schema_version !== 1 || provenance.revision !== revision ||
      provenance.release_version !== authority.release_version ||
      normalizeRepository(provenance.canonical_repository) !==
        normalizeRepository(authority.canonical_repository) ||
      provenance.required_public_ancestor !== authority.required_public_ancestor ||
      ![authority.canonical_repository, authority.staging_repository]
        .map(normalizeRepository)
        .includes(normalizeRepository(provenance.published_repository)) ||
      !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(String(provenance.published_ref || "")) ||
      !SHA_PATTERN.test(String(provenance.tree || "")) ||
      !provenance.files || typeof provenance.files !== "object") {
    throw new Error("packaged release provenance does not match source authority");
  }
  const observedFiles = walkFiles(releaseRoot);
  const expectedFiles = Object.keys(provenance.files).sort();
  if (JSON.stringify(observedFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("packaged release file set differs from provenance");
  }
  for (const relativePath of observedFiles) {
    const fullPath = path.join(releaseRoot, relativePath);
    const stat = fs.statSync(fullPath);
    const expected = provenance.files[relativePath];
    if (expected.sha256 !== sha256(fullPath) || expected.size !== stat.size ||
        expected.executable !== ((stat.mode & 0o111) !== 0)) {
      throw new Error(`packaged release file differs from provenance: ${relativePath}`);
    }
  }
  return Object.freeze(provenance);
}

export function verifyActivatableRelease(releaseRoot, revision) {
  if (!SHA_PATTERN.test(String(revision || ""))) {
    throw new Error("revision must be an exact 40-character Git commit SHA");
  }
  const checkout = git(releaseRoot, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (checkout.status === 0 && fs.realpathSync(checkout.stdout.trim()) === fs.realpathSync(releaseRoot)) {
    const lineage = assertSourceLineage(releaseRoot, { requireClean: true });
    if (lineage.revision !== revision) {
      throw new Error(`release checkout HEAD ${lineage.revision} does not match revision ${revision}`);
    }
    return Object.freeze({
      kind: "git-checkout",
      revision: lineage.revision,
      tree: lineage.tree,
      release_version: lineage.authority.release_version,
      canonical_repository: lineage.authority.canonical_repository,
    });
  }
  const packaged = verifyPackagedRelease(releaseRoot, revision);
  return Object.freeze({
    kind: "packaged-release",
    revision: packaged.revision,
    tree: packaged.tree,
    release_version: packaged.release_version,
    canonical_repository: packaged.canonical_repository,
    published_repository: packaged.published_repository,
    published_ref: packaged.published_ref,
  });
}

export { PROVENANCE_NAME };
