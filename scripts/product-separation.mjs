import fs from "node:fs";
import path from "node:path";

const predecessorSlug = ["codex", "mac", "link"].join("-");
const predecessorEnv = ["CODEX", "MAC", "LINK"].join("_");
const predecessorState = [".codex", "mac", "link"].join("-");
const predecessorLabel = ["com.harryhawk", predecessorSlug].join(".");
const predecessorName = ["Mac", "Link"].join(" ");

const forbidden = Object.freeze([
  predecessorEnv,
  predecessorState,
  predecessorSlug,
  predecessorLabel,
  predecessorName,
  ["plugins", predecessorSlug].join("/"),
]);
const ignoredDirectories = new Set([".git", "__pycache__"]);
const excluded = new Set([
  "scripts/check-hard-fork-parity.py",
  "config/hard-fork-parity.json",
  "docs/HARD-FORK-PARITY.md",
  "docs/release-flow.md",
]);
const runtimeRoots = new Set([
  ".codex-plugin", ".mcp.json", "scripts", "launchd", "config", "examples", "static",
]);
const rejectedRuntimePatterns = Object.freeze([
  { pattern: /simpletuner.{0,80}\brest\b|\brest\b.{0,80}simpletuner/is, name: "SimpleTuner REST control" },
  { pattern: /trainer[-_ ]queue[-_ ]policy/i, name: "alternate trainer queue policy" },
  { pattern: /schedule[-_ ]decision|window[-_ ]decision/i, name: "time-window scheduling decision" },
  { pattern: /overnight[-_ ]window|idle[-_ ]gate|time[-_ ]window[-_ ]gate/i, name: "time-window or idle gate" },
]);
const rejectedPatternTestFiles = new Set([
  "scripts/product-separation.mjs",
  "scripts/test-product-separation.mjs",
]);

function inspectPath(root, relative, violations) {
  if (excluded.has(relative)) return;
  const normalizedPath = relative.toLowerCase();
  for (const identifier of forbidden) {
    if (normalizedPath.includes(identifier.toLowerCase())) {
      violations.push({ path: relative, reason: `path contains predecessor identifier: ${identifier}` });
    }
  }
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return;
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    violations.push({ path: relative, reason: "distributable surface contains a symbolic link" });
    return;
  }
  if (stat.isDirectory()) {
    if (ignoredDirectories.has(path.basename(relative))) return;
    for (const name of fs.readdirSync(absolute).sort()) {
      inspectPath(root, path.join(relative, name), violations);
    }
    return;
  }
  if (!stat.isFile()) return;
  if (stat.nlink > 1) {
    violations.push({ path: relative, reason: "distributable surface contains a hard-linked file" });
  }
  const content = fs.readFileSync(absolute);
  if (content.includes(0)) return;
  const text = content.toString("utf8").toLowerCase();
  for (const identifier of forbidden) {
    if (text.includes(identifier.toLowerCase())) {
      violations.push({ path: relative, reason: `contains predecessor identifier: ${identifier}` });
    }
  }
  if (runtimeRoots.has(relative.split(path.sep)[0]) && !rejectedPatternTestFiles.has(relative)) {
    for (const { pattern, name } of rejectedRuntimePatterns) {
      if (pattern.test(text)) {
        violations.push({ path: relative, reason: `contains rejected runtime path: ${name}` });
      }
    }
  }
}

export function auditProductSeparation(root) {
  const resolvedRoot = fs.realpathSync(root);
  const violations = [];
  for (const name of fs.readdirSync(resolvedRoot).sort()) {
    inspectPath(resolvedRoot, name, violations);
  }

  const manifestPath = path.join(resolvedRoot, ".codex-plugin/plugin.json");
  if (!fs.existsSync(manifestPath)) {
    violations.push({ path: ".codex-plugin/plugin.json", reason: "HawkSpan manifest is missing" });
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.name !== "hawkspan") {
      violations.push({ path: ".codex-plugin/plugin.json", reason: "manifest name is not hawkspan" });
    }
    if (manifest.interface?.displayName !== "HawkSpan") {
      violations.push({ path: ".codex-plugin/plugin.json", reason: "display name is not HawkSpan" });
    }
  }

  const mcpPath = path.join(resolvedRoot, ".mcp.json");
  if (!fs.existsSync(mcpPath)) {
    violations.push({ path: ".mcp.json", reason: "HawkSpan MCP registration is missing" });
  } else {
    const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    if (JSON.stringify(Object.keys(mcp.mcpServers || {})) !== JSON.stringify(["hawkspan"])) {
      violations.push({ path: ".mcp.json", reason: "MCP registration is not exactly hawkspan" });
    }
  }

  return Object.freeze({
    valid: violations.length === 0,
    root: resolvedRoot,
    scanned_surfaces: ["entire release root"],
    excluded_provenance_files: [...excluded].sort(),
    violations: Object.freeze(violations),
  });
}

export function assertProductSeparated(root) {
  const result = auditProductSeparation(root);
  if (!result.valid) {
    throw new Error(`HawkSpan product separation failed:\n${JSON.stringify(result.violations, null, 2)}`);
  }
  return result;
}
