# Application plugin author guide

A plugin is one non-symlink directory whose basename equals its manifest ID:

```text
hello-world/
  hawkspan-plugin.json
  plugin.mjs
```

The public harmless example is in `examples/plugins/hello-world`. Its manifest
declares schema version, ID, display name, version, one local `.mjs`
entrypoint, and operations. Each operation declares roles, access origins, an
object input schema, and MCP annotations.

### Optional quick-start presets

A plugin can expose reviewed, named quick starts through a manifest `presets`
array. Each preset has a stable kebab-case `id`, a human `name`, `description`,
`impact`, and `settings`. First-release settings contain only the required
`enabled_operations` array. Operation names must be unique and declared by the
same manifest.

```json
{
  "presets": [{
    "id": "headless-worker",
    "name": "Headless application worker",
    "description": "Run only the reviewed worker operations on this Mac.",
    "impact": "Accepts selected application tools and blocks broad commands.",
    "settings": { "enabled_operations": ["submit", "status"] }
  }]
}
```

Do not put roles, control capabilities, connection values, credentials, paths,
tokens, application options, or workload data in presets. Keep application-specific integrations in their
separately installable plugins rather than public HawkSpan core; sanitized
plugins can themselves be public releases.

The module exports:

```js
export async function activate(context) {
  return {
    operations: {
      async operation_name(args, run) {
        return { ok: true };
      }
    },
    async start() {},
    async stop() {}
  };
}
```

`run` provides `runId`, `origin`, and an `AbortSignal`. Long operations must
observe the signal and stop safely. `context.stateDirectory` is the plugin's
HawkSpan-owned artifact area. `context.callCoreTool` can call only tools in the
user's `core_tool_allowlist`; the default is none. `context.configuration` is
the deeply frozen, non-secret JSON object from the plugin entry's
`configuration` field.

For an operation that must be tied to explicit recorded authorization, call:

```js
const job = context.require_authorized_job({
  job_id: args.job_id,
  kind: "export",
  states: ["authorized", "queued"],
});
```

The lookup is exact. It returns only the job ID, kind, state, and authorization
state, requires `authorization_state` to be `recorded`, optionally enforces one
kind and a list of acceptable states, and audits both approval and denial. It
does not expose authorization evidence or arbitrary job metadata.

Treat all arguments as untrusted data. Prefer process APIs that pass an
executable and argument vector. Do not concatenate arguments into a shell
command. Apply application-specific allowlists, normalize output paths under
the plugin state directory, reject symlinks, cap payload sizes, and avoid
placing secrets in results or audit details.

Plugins execute in the HawkSpan process with the HawkSpan user's privileges.
There is no code sandbox. Authors must document external processes, network
access, application permissions, artifacts, cancellation semantics,
idempotency, and recovery. Keep manifest access and roles as narrow as the
operation permits.
