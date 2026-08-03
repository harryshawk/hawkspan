# Application plugins

HawkSpan application plugins are optional adapters layered on the durable
coordination core. The core does not contain behavior for individual
applications. A SyntheticRender or SyntheticDraw integration, for example, belongs
in a separately installed plugin that declares operations and implements them
through the public runtime contract.

## User configuration

`application_plugins.roles` determines what this node may do. The default is
`["controller", "worker"]`, which preserves symmetric behavior. A deployment
may set one node to `["controller"]` and the other to `["worker"]`. Operation
manifests declare eligible roles and call origins (`local`, `peer`, and
`html`). Per-plugin configuration may further narrow origins and enabled
operations:

```json
{
  "application_plugins": {
    "enabled": true,
    "roles": ["worker"],
    "roots": ["/Users/localuser/.hawkspan/plugins"],
    "feature_flags": {
      "render-submit": true
    },
    "core_tool_allowlist": ["register_artifact", "verify_artifact"],
    "entries": {
      "example-renderer": {
        "enabled": true,
        "allowed_origins": ["peer"],
        "enabled_operations": ["submit", "cancel"],
        "configuration": {
          "mode": "preview",
          "batch_size": 2
        }
      }
    }
  }
}
```

Configuration is read at server start. Users can edit it later and restart
HawkSpan. Omitting roles retains controller/worker symmetry. Restrictions only
narrow manifest permissions; they do not grant an origin or role the manifest
does not declare. The optional per-entry `configuration` value must be a JSON
object, may be at most 64 KiB and 16 levels deep, and is passed to activation as
an immutable copy. Secret-shaped fields—including tokens, passwords,
credentials, private keys, and authorization values—are rejected. Plugins
should use application-native credential storage instead of HawkSpan entry
configuration.

For an asymmetric deployment where a plugin exists only on the worker, the
controller explicitly allowlists the remote generated tool names under
`peer.allowed_tools`:

```json
{
  "peer": {
    "allowed_tools": [
      "app_synthetic_render_render",
      "app_synthetic_draw_draw"
    ]
  }
}
```

This outbound allowlist permits the controller to send only those named calls.
The worker still independently enforces plugin installation, role, origin,
operation, feature-flag, and input-schema restrictions.

## Runtime behavior

Each accepted operation becomes an MCP tool named
`app_<plugin_id>_<operation>`. HawkSpan validates the manifest, role, origin,
feature flags, operation allowlist, and JSON input before calling plugin code.
Runs have durable queued, running, completed, failed, cancelled, or interrupted
states. `application_plugin_status` lists loaded plugins, rejected candidates,
and recent runs. Its optional `run_id`, `plugin`, `operation`, and `state`
filters use exact matches; its result limit remains bounded from 1 through 500.
`application_plugin_cancel` sends cooperative cancellation to an active run.
Runs still active after a server restart are marked interrupted for explicit
recovery.

Operation schemas support object, array, string, boolean, integer, number, and
null types, including type unions. The runtime enforces required properties,
additional-property rejection, enums, constants, patterns, minimum and maximum
lengths and numeric values, and minimum and maximum array sizes.

Plugin candidates are rejected if their directory, manifest, or entrypoint is
a symbolic link; if an entrypoint uses traversal; if IDs or operation names are
invalid; or if declarations and implementations disagree.

## Agent use

1. Call `application_plugin_status`.
2. Confirm the expected plugin version, operation, node role, and origin.
3. Create a HawkSpan job when work needs durable authorization or progress
   evidence.
4. Call the generated application tool with schema-valid arguments.
5. Record the returned run ID with the job or artifact.
6. On interruption, inspect run and artifact state before retrying. Do not
   assume an interrupted external application operation is safe to repeat.
7. Use cooperative cancellation first and verify external application state.

Application plugins do not weaken the user's authority boundary. Publishing,
deletion, credential use, or other consequential work still needs the same
explicit authorization it would require through a core HawkSpan command.

## Reviewed application quick starts

An installed plugin may declare named `presets` in its manifest. These are
sanitized quick starts, not application configuration. A preset may contain
only `role_profile`, `node_role`, approved HawkSpan `features`, and an explicit
`enabled_operations` list drawn from that same manifest. If it restricts peer
tools, every tool must be an explicit generated tool belonging to that plugin.
A preset cannot enable HawkSpan's broad command tool. Its peer-tool lists may
contain same-plugin operations plus only HawkSpan's fixed safe core coordination
subset: `create_job`, `update_job_status`, `list_jobs`, and
`receive_artifacts`. Arbitrary core tools are rejected before plugin activation.

Presets can never contain or change connections, credentials, paths, tokens,
local-control settings, plugin configuration, another plugin's entry, or
application data. Public core stays application-neutral; presets appear only
after their reviewed, separately installable plugin is installed. Sanitized
plugins may be released publicly without being bundled into core.

Use the four MCP tools in this order:

1. `list_application_presets({})` lists quick starts exposed by validated,
   currently installed plugins.
2. `preview_application_preset({"preset_id":"plugin-id/preset-id"})` shows
   the exact approved changes and preserved categories without writing.
3. `apply_application_preset({"preset_id":"plugin-id/preset-id","confirm":true})`
   atomically replaces role/capability overrides and narrows that plugin's
   enabled operations. Restart HawkSpan afterward.
4. `reset_application_preset({"preset_id":"plugin-id/preset-id","confirm":true})`
   removes role/capability overrides and that plugin's operation restriction,
   returning those settings to inherited defaults. It preserves private and
   installation data and also requires a restart.

Preset IDs remain stable while the plugin keeps its manifest ID and preset ID
unchanged. Review the preview and plugin source before confirming either write.
