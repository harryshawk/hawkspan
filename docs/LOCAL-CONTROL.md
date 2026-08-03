# Local HTML control

HawkSpan starts a small HTML control surface by default. It binds only to
`127.0.0.1`, selects an available local port when `port` is `0`, and reports
the exact URL from `link_status`. It never binds to a LAN address or all
interfaces. A non-loopback `host` is rejected.

An installation agent such as Codex or Claude Code may configure and start
this service for the owner. The dashboard is deliberately human-usable after
installation and does not require that installation agent to remain attached.
Top navigation separates status and tools, configuration, and help. The
Configuration tab includes reviewed use-case profiles, locally named profiles,
individual capability flags, installed-plugin application quick starts, and
confirmed resets to inherited defaults.

Users may select a stable local port or disable the surface later:

```json
{
  "local_control": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 8765,
    "route_labels": {
      "primary": "Thunderbolt",
      "fallback": "Ethernet"
    },
    "allowed_tools": [
      "mcp_status",
      "get_configuration",
      "update_configuration",
      "get_connection_configuration",
      "update_connection_configuration",
      "reset_configuration",
      "list_configuration_profiles",
      "save_configuration_profile",
      "apply_configuration_profile",
      "delete_configuration_profile",
      "list_application_presets",
      "preview_application_preset",
      "apply_application_preset",
      "reset_application_preset",
      "link_status",
      "application_plugin_status",
      "list_messages",
      "list_jobs",
      "list_artifacts",
      "list_audit_events",
      "app_hello_world_greet"
    ]
  }
}
```

Set `enabled` to `false` and restart to disable it.

For foreground validation, run `node scripts/start-local-control.mjs`. It
prints the exact loopback URL and keeps the dashboard available until stopped.
`scripts/call-tool.mjs` intentionally disables its own short-lived dashboard,
so it is not the foreground dashboard launcher.

For a consistent URL that remains available between tool calls, choose a
nonzero port and install the persistent local-control agent:

```sh
HAWKSPAN_NODE=/path/to/node scripts/install-local-control-agent.sh
```

The page is not a second implementation. `POST /api/call` invokes the same
in-process tool map used by MCP, including plugin schema, role, origin,
feature-flag, lifecycle, and audit handling. The server also enforces a
separate HTML tool allowlist and a random per-process request token embedded in
the page.

Loopback is an important boundary, not authentication against other software
running in the same user session. A malicious local process may be able to
read or drive the page. Keep the HTML allowlist narrow, do not expose the port
through a proxy or tunnel, and disable the surface where the local account is
not fully trusted.

## Upgrading an existing installation

Installations that already define an explicit `local_control.allowed_tools`
array must add `reset_configuration`, `list_configuration_profiles`,
`save_configuration_profile`, `apply_configuration_profile`, and
`delete_configuration_profile` to use profile management and reset from the
HTML interface. Add `get_connection_configuration` and
`update_connection_configuration` to edit route availability, labels, and
hosts. Add `list_application_presets`, `preview_application_preset`,
`apply_application_preset`, and `reset_application_preset` to use installed
plugin quick starts. Until then, the page keeps the corresponding controls
disabled and explains the required update. Existing peer, SSH, path, plugin,
and local-control settings remain unchanged.

Check installed services with:

```sh
launchctl print "gui/$(id -u)/org.hawkspan.link-agent"
launchctl print "gui/$(id -u)/org.hawkspan.local-control"
```

If a service does not stay running, inspect
`~/.hawkspan/audit/link-agent-error.log` or
`~/.hawkspan/audit/local-control-error.log` before changing configuration.
Their standard-output companions omit `-error`. These logs are local
installation data and must not be committed.
