# Local HTML control

HawkSpan starts a lightweight HTML control surface on `127.0.0.1`. It selects
an available port when `local_control.port` is `0`; `link_status` reports the
exact URL. A non-loopback host is rejected.

The page calls the same HawkSpan-D MCP handlers used by agents. It is not a
second control or transport implementation. The first release exposes status,
durable messages, jobs, artifacts, audit history, installed packages, and
operation-selection presets. Connection editing and role/capability profiles
are retained for later work and are not enabled by the first-release tool
allowlist. The same role, allowlist, broad-command, and
`allow_peer_commands` keys in the active config are still enforced at the
peer/command boundary. Controller inbound and worker outbound peer-tool
lists stay empty in controller-worker mode unless those lists are set.

```json
{
  "local_control": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 8765,
    "allowed_tools": [
      "link_status",
      "application_plugin_status",
      "application_plugin_cancel",
      "list_messages",
      "list_jobs",
      "list_artifacts",
      "list_audit_events",
      "list_application_presets",
      "preview_application_preset",
      "apply_application_preset",
      "reset_application_preset"
    ]
  }
}
```

Set `enabled` to `false` and restart HawkSpan to disable the surface. Keep the
allowlist narrow and do not expose the loopback port through a proxy or tunnel.
The random page token protects against accidental calls, but other software in
the same user session remains inside the local trust boundary.
