import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const IDENTIFIER = /^[a-z][a-z0-9-]{0,62}$/;
const OPERATION = /^[a-z][a-z0-9_]{0,62}$/;
const CORE_TOOL = /^[a-z][a-z0-9_]{0,127}$/;
const ROLES = new Set(["controller", "worker"]);
const ACCESS = new Set(["local", "peer", "html"]);
const PLUGIN_RUN_STATES = new Set([
  "queued", "running", "cancel_requested", "completed", "failed", "cancelled", "interrupted",
]);
const SECRET_KEY = /(token|secret|password|passwd|credential|privatekey|apikey|authorization)/;
const MAX_ENTRY_CONFIGURATION_BYTES = 64 * 1024;
const MAX_CONFIGURATION_DEPTH = 16;

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyAndValidateConfiguration(value, at = "configuration", depth = 0) {
  if (depth > MAX_CONFIGURATION_DEPTH) throw new Error(`${at} is nested too deeply`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => copyAndValidateConfiguration(entry, `${at}[${index}]`, depth + 1));
  }
  if (!plainObject(value)) throw new Error(`${at} must contain only JSON values`);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key.toLowerCase().replaceAll(/[^a-z0-9]/g, ""))) {
      throw new Error(`${at}.${key} may not contain secrets or credentials`);
    }
    result[key] = copyAndValidateConfiguration(entry, `${at}.${key}`, depth + 1);
  }
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizedEntryConfiguration(perPlugin) {
  const supplied = perPlugin.configuration ?? {};
  if (!plainObject(supplied)) throw new Error("plugin configuration must be an object");
  const copied = copyAndValidateConfiguration(supplied);
  if (Buffer.byteLength(JSON.stringify(copied), "utf8") > MAX_ENTRY_CONFIGURATION_BYTES) {
    throw new Error("plugin configuration must be no larger than 64 KiB");
  }
  return deepFreeze(copied);
}

function assertInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} escapes its configured root`);
}

function rejectSymlinks(root, candidate) {
  assertInside(root, candidate, "plugin path");
  let current = root;
  const relative = path.relative(root, candidate);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`symbolic links are not allowed in plugins: ${current}`);
    }
  }
}

function rejectUnsafeTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`symbolic links are not allowed in plugins: ${candidate}`);
    }
    if (stat.isDirectory()) rejectUnsafeTree(candidate);
    else if (!stat.isFile()) throw new Error(`plugin entries must be regular files: ${candidate}`);
  }
}

function validateSchema(value, schema, at = "arguments") {
  if (!schema) return;
  const declaredTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matchesType = (type) => (
    (type === "null" && value === null) ||
    (type === "object" && plainObject(value)) ||
    (type === "array" && Array.isArray(value)) ||
    (type === "string" && typeof value === "string") ||
    (type === "boolean" && typeof value === "boolean") ||
    (type === "integer" && Number.isInteger(value)) ||
    (type === "number" && typeof value === "number" && Number.isFinite(value))
  );
  const matchedType = declaredTypes.find(matchesType);
  if (schema.type !== undefined && !matchedType) {
    throw new Error(`${at} must be ${declaredTypes.join(" or ")}`);
  }
  if (matchedType === "object") {
    if (!plainObject(value)) throw new Error(`${at} must be an object`);
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (!(required in value)) throw new Error(`${at}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) throw new Error(`${at}.${key} is not allowed`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) validateSchema(value[key], child, `${at}.${key}`);
    }
  } else if (matchedType === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${at} has too few items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new Error(`${at} has too many items`);
    }
    value.forEach((entry, index) => validateSchema(entry, schema.items, `${at}[${index}]`));
  } else if (matchedType === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new Error(`${at} is too short`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new Error(`${at} is too long`);
    }
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) {
      throw new Error(`${at} has an invalid format`);
    }
  } else if (matchedType === "integer" || matchedType === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${at} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${at} is above maximum`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${at} is not an allowed value`);
  if (Object.hasOwn(schema, "const") && !Object.is(schema.const, value)) {
    throw new Error(`${at} must equal its declared constant`);
  }
}

export function validatePluginDirectory(pluginDirectory, expectedRoot = path.dirname(pluginDirectory)) {
  const root = fs.realpathSync(expectedRoot);
  const requestedDirectory = path.resolve(pluginDirectory);
  if (fs.lstatSync(requestedDirectory).isSymbolicLink()) {
    throw new Error(`symbolic links are not allowed in plugins: ${requestedDirectory}`);
  }
  const directory = fs.realpathSync(requestedDirectory);
  assertInside(root, directory, "plugin directory");
  rejectSymlinks(root, directory);
  const stat = fs.statSync(directory);
  if (!stat.isDirectory()) throw new Error("plugin path must be a directory");
  rejectUnsafeTree(directory);

  const manifestPath = path.join(directory, "hawkspan-plugin.json");
  rejectSymlinks(root, manifestPath);
  const manifestStat = fs.statSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.size > 256 * 1024) {
    throw new Error("plugin manifest must be a regular file no larger than 256 KiB");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schema_version !== 1) throw new Error("unsupported plugin schema_version");
  if (!IDENTIFIER.test(manifest.id || "")) throw new Error("invalid plugin id");
  if (path.basename(directory) !== manifest.id) {
    throw new Error("plugin directory name must equal the plugin id");
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new Error("plugin name is required");
  }
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+([+-][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error("plugin version must be semantic-version shaped");
  }
  if (typeof manifest.entrypoint !== "string" ||
      path.posix.basename(manifest.entrypoint) !== manifest.entrypoint ||
      !manifest.entrypoint.endsWith(".mjs")) {
    throw new Error("entrypoint must be one local .mjs filename");
  }
  const entrypoint = path.join(directory, manifest.entrypoint);
  rejectSymlinks(root, entrypoint);
  if (!fs.statSync(entrypoint).isFile()) throw new Error("plugin entrypoint must be a regular file");
  if (!Array.isArray(manifest.operations) || manifest.operations.length === 0) {
    throw new Error("plugin must declare at least one operation");
  }
  const operationNames = new Set();
  for (const operation of manifest.operations) {
    if (!OPERATION.test(operation?.name || "")) throw new Error("invalid plugin operation name");
    if (operationNames.has(operation.name)) throw new Error(`duplicate operation: ${operation.name}`);
    operationNames.add(operation.name);
    for (const role of operation.roles || ["controller", "worker"]) {
      if (!ROLES.has(role)) throw new Error(`invalid operation role: ${role}`);
    }
    for (const origin of operation.access || ["local", "peer"]) {
      if (!ACCESS.has(origin)) throw new Error(`invalid operation access: ${origin}`);
    }
    for (const flag of operation.required_flags || []) {
      if (!IDENTIFIER.test(flag)) throw new Error(`invalid required flag: ${flag}`);
    }
    if (operation.inputSchema && operation.inputSchema.type !== "object") {
      throw new Error("operation inputSchema must describe an object");
    }
  }
  const presetIds = new Set();
  if (manifest.presets !== undefined && !Array.isArray(manifest.presets)) {
    throw new Error("plugin presets must be an array");
  }
  for (const preset of manifest.presets || []) {
    if (!plainObject(preset)) throw new Error("plugin preset must be an object");
    if (!Object.keys(preset).every((key) =>
      ["id", "name", "description", "impact", "settings"].includes(key))) {
      throw new Error("plugin preset contains an unsupported key");
    }
    if (!IDENTIFIER.test(preset.id || "")) throw new Error("invalid plugin preset id");
    if (presetIds.has(preset.id)) throw new Error(`duplicate plugin preset: ${preset.id}`);
    presetIds.add(preset.id);
    for (const key of ["name", "description", "impact"]) {
      if (typeof preset[key] !== "string" || !preset[key].trim() || preset[key].length > 400 ||
          /[\u0000-\u001f\u007f]/u.test(preset[key])) {
        throw new Error(`plugin preset ${key} must contain 1 to 400 printable characters`);
      }
    }
    if (!plainObject(preset.settings) || !Object.keys(preset.settings).every((key) =>
      ["role_profile", "node_role", "features", "enabled_operations"].includes(key))) {
      throw new Error("plugin preset settings contain an unsupported key");
    }
    if (!Array.isArray(preset.settings.enabled_operations) ||
         preset.settings.enabled_operations.some((name) => !operationNames.has(name)) ||
         new Set(preset.settings.enabled_operations).size !== preset.settings.enabled_operations.length) {
      throw new Error("plugin preset enabled_operations must be unique declared operation names");
    }
    if (preset.settings.role_profile !== undefined &&
        !["symmetric", "controller-worker"].includes(preset.settings.role_profile)) {
      throw new Error("plugin preset role_profile is invalid");
    }
    if (preset.settings.node_role !== undefined &&
        !["controller", "worker"].includes(preset.settings.node_role)) {
      throw new Error("plugin preset node_role is invalid");
    }
    if (preset.settings.features !== undefined && !plainObject(preset.settings.features)) {
      throw new Error("plugin preset features must be an object");
    }
  }
  return { directory, entrypoint, manifest };
}

function normalizedConfiguration(config, stateRoot) {
  const supplied = config.application_plugins || {};
  const roles = supplied.roles || ["controller", "worker"];
  if (!Array.isArray(roles) || roles.length === 0 || roles.some((role) => !ROLES.has(role))) {
    throw new Error("application_plugins.roles must contain controller and/or worker");
  }
  const roots = supplied.roots || [path.join(stateRoot, "plugins")];
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")) {
    throw new Error("application_plugins.roots must be an array of paths");
  }
  return {
    enabled: supplied.enabled !== false,
    roles: new Set(roles),
    roots: roots.map((root) => path.resolve(root)),
    featureFlags: plainObject(supplied.feature_flags) ? supplied.feature_flags : {},
    entries: plainObject(supplied.entries) ? supplied.entries : {},
  };
}

export async function createApplicationPluginFramework({
  config,
  stateRoot,
  db,
  audit,
  callCoreTool,
  environment = Object.freeze({}),
  redact = (value) => value,
  validatePreset = () => {},
}) {
  const settings = normalizedConfiguration(config, stateRoot);
  const plugins = new Map();
  const operations = new Map();
  const activeRuns = new Map();
  const rejected = [];

  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_runs (
      id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      origin TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      result_json TEXT,
      error TEXT
    );
    UPDATE plugin_runs
      SET state='interrupted', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          error=coalesce(error, 'server stopped before the operation completed')
      WHERE state IN ('queued','running','cancel_requested');
  `);

  const runtimeNow = () => new Date().toISOString();
  const makeRunId = () => `plugin-run-${Date.now()}-${Math.random().toString(16).slice(2, 14)}`;
  const safeFrameworkError = (message) => Object.assign(new Error(message), { hawkspanSafe: true });
  const pluginArtifactRoot = path.join(stateRoot, "plugin-artifacts");
  fs.mkdirSync(pluginArtifactRoot, { recursive: true, mode: 0o700 });

  async function discover() {
    if (!settings.enabled) return;
    for (const rootPath of settings.roots) {
      if (!fs.existsSync(rootPath)) continue;
      const rootStat = fs.lstatSync(rootPath);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        rejected.push({ candidate: "configured-root", error: "application plugin validation failed" });
        continue;
      }
      for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
        const candidate = path.join(rootPath, entry.name);
        try {
          if (!entry.isDirectory() || entry.isSymbolicLink()) {
            throw new Error("plugin candidates must be non-symlink directories");
          }
          const validated = validatePluginDirectory(candidate, rootPath);
          for (const preset of validated.manifest.presets || []) {
            validatePreset({
              ...preset,
              id: `${validated.manifest.id}/${preset.id}`,
              plugin_id: validated.manifest.id,
              plugin_name: validated.manifest.name,
              plugin_version: validated.manifest.version,
            });
          }
          const perPlugin = settings.entries[validated.manifest.id] || {};
          if (!plainObject(perPlugin)) throw new Error("plugin entry configuration must be an object");
          if (perPlugin.enabled === false) continue;
          if (perPlugin.core_tool_allowlist !== undefined &&
              (!Array.isArray(perPlugin.core_tool_allowlist) ||
               perPlugin.core_tool_allowlist.some((name) => typeof name !== "string" || !CORE_TOOL.test(name)))) {
            throw new Error("plugin core_tool_allowlist contains an invalid core tool name");
          }
          const entryConfiguration = normalizedEntryConfiguration(perPlugin);
          const module = await import(`${pathToFileURL(validated.entrypoint).href}?v=${encodeURIComponent(validated.manifest.version)}`);
          if (typeof module.activate !== "function") throw new Error("plugin must export activate(context)");
          if (plugins.has(validated.manifest.id)) {
            throw new Error(`duplicate plugin id: ${validated.manifest.id}`);
          }
          const pluginArtifactDirectory = path.join(pluginArtifactRoot, validated.manifest.id);
          fs.mkdirSync(pluginArtifactDirectory, { recursive: true, mode: 0o700 });
          const implementation = await module.activate(Object.freeze({
            pluginId: validated.manifest.id,
            stateDirectory: pluginArtifactDirectory,
            configuration: entryConfiguration,
            environment,
            callCoreTool: async (name, args = {}) => callCoreTool(name, args, "plugin", validated.manifest.id),
            require_authorized_job: ({ job_id: jobId, kind, states } = {}) => {
              if (typeof jobId !== "string" || !jobId) throw new Error("job_id is required");
              if (kind !== undefined && (typeof kind !== "string" || !kind)) {
                throw new Error("kind must be a non-empty string");
              }
              if (states !== undefined &&
                  (!Array.isArray(states) || states.length === 0 ||
                   states.some((state) => typeof state !== "string" || !state))) {
                throw new Error("states must be a non-empty array of strings");
              }
              const job = db.prepare("SELECT id,kind,state,authorization_state FROM jobs WHERE id=?").get(jobId);
              let reason = null;
              if (!job) reason = "not_found";
              else if (job.authorization_state !== "recorded") reason = "authorization_not_recorded";
              else if (kind !== undefined && job.kind !== kind) reason = "kind_mismatch";
              else if (states !== undefined && !states.includes(job.state)) reason = "state_mismatch";
              audit("authorize", "job", jobId, reason ? "denied" : "allowed", {
                plugin_id: validated.manifest.id,
                required_kind: kind ?? null,
                required_states: states ?? null,
                reason,
              });
              if (reason === "not_found") throw safeFrameworkError(`job not found: ${jobId}`);
              if (reason === "authorization_not_recorded") throw safeFrameworkError("job authorization is not recorded");
              if (reason === "kind_mismatch") throw safeFrameworkError(`job kind does not match: ${kind}`);
              if (reason === "state_mismatch") throw safeFrameworkError("job state is not authorized for this operation");
              return Object.freeze({ job_id: job.id, kind: job.kind, state: job.state, authorization_state: job.authorization_state });
            },
          }));
          if (!plainObject(implementation?.operations)) {
            throw new Error("activate() must return an operations object");
          }
          const record = { ...validated, configuration: perPlugin, implementation };
          if (perPlugin.allowed_origins &&
              (!Array.isArray(perPlugin.allowed_origins) ||
               perPlugin.allowed_origins.some((origin) => !ACCESS.has(origin)))) {
            throw new Error("allowed_origins contains an invalid origin");
          }
          if (perPlugin.enabled_operations &&
              (!Array.isArray(perPlugin.enabled_operations) ||
               perPlugin.enabled_operations.some((name) => !OPERATION.test(name)))) {
            throw new Error("enabled_operations contains an invalid operation");
          }
          const generatedOperations = [];
          for (const operation of validated.manifest.operations) {
            if (typeof implementation.operations[operation.name] !== "function") {
              throw new Error(`missing implementation for operation: ${operation.name}`);
            }
            const toolName = `app_${validated.manifest.id.replaceAll("-", "_")}_${operation.name}`;
            if (operations.has(toolName) ||
                generatedOperations.some(([candidate]) => candidate === toolName)) {
              throw new Error(`duplicate generated tool name: ${toolName}`);
            }
            generatedOperations.push([toolName, { plugin: record, operation }]);
          }
          if (typeof implementation.start === "function") await implementation.start();
          plugins.set(validated.manifest.id, record);
          for (const [toolName, target] of generatedOperations) operations.set(toolName, target);
          audit("load", "application_plugin", validated.manifest.id, "loaded", {
            version: validated.manifest.version,
            operations: validated.manifest.operations.map((operation) => operation.name),
          });
        } catch (error) {
          rejected.push({ candidate: entry.name, error: "application plugin validation failed" });
          audit("load", "application_plugin", entry.name, "rejected", {
            error: "application plugin validation failed",
          });
        }
      }
    }
  }

  function authorize(record, operation, origin) {
    const pluginConfig = record.configuration;
    const allowedRoles = operation.roles || ["controller", "worker"];
    if (!allowedRoles.some((role) => settings.roles.has(role))) {
      throw new Error(`operation is not authorized for this node's roles`);
    }
    const access = operation.access || ["local", "peer"];
    if (!access.includes(origin)) throw new Error(`operation does not allow ${origin} access`);
    if (pluginConfig.allowed_origins && !pluginConfig.allowed_origins.includes(origin)) {
      throw new Error(`plugin configuration denies ${origin} access`);
    }
    if (pluginConfig.enabled_operations &&
        !pluginConfig.enabled_operations.includes(operation.name)) {
      throw new Error("operation is disabled by plugin configuration");
    }
    for (const flag of operation.required_flags || []) {
      if (settings.featureFlags[flag] !== true) {
        throw new Error(`required feature flag is disabled: ${flag}`);
      }
    }
  }

  async function invoke(toolName, args, origin) {
    const target = operations.get(toolName);
    if (!target) throw new Error(`unknown application plugin tool: ${toolName}`);
    authorize(target.plugin, target.operation, origin);
    validateSchema(args, target.operation.inputSchema || {
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    const runId = makeRunId();
    const timestamp = runtimeNow();
    db.prepare(`
      INSERT INTO plugin_runs
        (id,plugin_id,operation,origin,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      runId,
      target.plugin.manifest.id,
      target.operation.name,
      origin,
      "queued",
      timestamp,
      timestamp,
    );
    const controller = new AbortController();
    activeRuns.set(runId, controller);
    db.prepare("UPDATE plugin_runs SET state='running',updated_at=? WHERE id=?")
      .run(runtimeNow(), runId);
    try {
      const result = await target.plugin.implementation.operations[target.operation.name](
        args,
        Object.freeze({ runId, signal: controller.signal, origin }),
      );
      const state = controller.signal.aborted ? "cancelled" : "completed";
      db.prepare(`
        UPDATE plugin_runs SET state=?,updated_at=?,result_json=? WHERE id=?
      `).run(state, runtimeNow(), JSON.stringify(result ?? null), runId);
      audit("invoke", "application_plugin", target.plugin.manifest.id, state, {
        run_id: runId,
        operation: target.operation.name,
        origin,
      });
      return { run_id: runId, plugin_id: target.plugin.manifest.id, operation: target.operation.name, state, result };
    } catch (error) {
      const state = controller.signal.aborted ? "cancelled" : "failed";
      const safeError = error?.hawkspanSafe === true
        ? String(redact(error.message))
        : controller.signal.aborted
          ? "application plugin operation cancelled"
          : "application plugin operation failed";
      db.prepare(`
        UPDATE plugin_runs SET state=?,updated_at=?,error=? WHERE id=?
      `).run(state, runtimeNow(), safeError, runId);
      audit("invoke", "application_plugin", target.plugin.manifest.id, state, {
        run_id: runId,
        operation: target.operation.name,
        origin,
        error: safeError,
      });
      throw new Error(safeError);
    } finally {
      activeRuns.delete(runId);
    }
  }

  function status(args = {}) {
    const limit = Math.min(Math.max(Number(args.limit || 50), 1), 500);
    const filters = [];
    const values = [];
    for (const [column, value] of [
      ["id", args.run_id], ["plugin_id", args.plugin], ["operation", args.operation], ["state", args.state],
    ]) {
      if (value !== undefined) {
        if (typeof value !== "string" || !value) throw new Error(`${column} filter must be a non-empty string`);
        filters.push(`${column}=?`);
        values.push(value);
      }
    }
    if (args.state !== undefined && !PLUGIN_RUN_STATES.has(args.state)) throw new Error("invalid plugin run state");
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const runs = db.prepare(`SELECT * FROM plugin_runs ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, limit).map((row) => ({
      ...row,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      result_json: undefined,
    }));
    return {
      enabled: settings.enabled,
      roles: [...settings.roles],
      plugins: [...plugins.values()].map((entry) => ({
        id: entry.manifest.id,
        name: entry.manifest.name,
        version: entry.manifest.version,
        operations: entry.manifest.operations.map((operation) => operation.name),
      })),
      rejected,
      runs,
    };
  }

  function cancel(args) {
    const row = db.prepare("SELECT * FROM plugin_runs WHERE id=?").get(args.run_id);
    if (!row) throw new Error(`plugin run not found: ${args.run_id}`);
    const controller = activeRuns.get(args.run_id);
    if (!controller) {
      if (["completed", "failed", "cancelled", "interrupted"].includes(row.state)) {
        return { run_id: row.id, state: row.state, active: false };
      }
      db.prepare("UPDATE plugin_runs SET state='cancelled',updated_at=? WHERE id=?")
        .run(runtimeNow(), row.id);
      return { run_id: row.id, state: "cancelled", active: false };
    }
    db.prepare("UPDATE plugin_runs SET state='cancel_requested',updated_at=? WHERE id=?")
      .run(runtimeNow(), row.id);
    controller.abort();
    return { run_id: row.id, state: "cancel_requested", active: true };
  }

  await discover();

  const tools = [
    {
      name: "application_plugin_status",
      description: "List validated application plugins, rejected candidates, and recent durable runs.",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string", minLength: 1 },
          plugin: { type: "string", minLength: 1 },
          operation: { type: "string", minLength: 1 },
          state: { type: "string", enum: [...PLUGIN_RUN_STATES] },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
      handler: status,
      allowedOrigins: new Set(["local", "peer", "html", "plugin"]),
    },
    {
      name: "application_plugin_cancel",
      description: "Request cooperative cancellation of an active application-plugin run.",
      inputSchema: {
        type: "object",
        required: ["run_id"],
        properties: { run_id: { type: "string" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: cancel,
      allowedOrigins: new Set(["local", "peer", "html"]),
    },
    ...[...operations.entries()].map(([name, target]) => ({
      name,
      description: target.operation.description ||
        `${target.plugin.manifest.name}: ${target.operation.name}`,
      inputSchema: target.operation.inputSchema || {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: target.operation.annotations || {
        readOnlyHint: false,
        destructiveHint: false,
      },
      handler: (args, origin = "local") => invoke(name, args, origin),
      allowedOrigins: new Set(target.operation.access || ["local", "peer"]),
      applicationPlugin: true,
    })),
  ];

  return {
    tools,
    status,
    presets: [...plugins.values()].flatMap((record) =>
      (record.manifest.presets || []).map((preset) => ({
        id: `${record.manifest.id}/${preset.id}`,
        plugin_id: record.manifest.id,
        plugin_name: record.manifest.name,
        plugin_version: record.manifest.version,
        name: preset.name,
        description: preset.description,
        impact: preset.impact,
        settings: structuredClone(preset.settings),
      }))),
    close: async () => {
      for (const record of plugins.values()) {
        if (typeof record.implementation.stop === "function") await record.implementation.stop();
      }
    },
  };
}
