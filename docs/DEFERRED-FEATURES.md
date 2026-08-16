# HawkSpan feature inventory

HawkSpan-D's MCP server is D's control foundation. HawkSpan packages and presets
select and parameterize that existing tool map; they do not replace it.

## Present in D and enabled for the first release

- loopback-only web interface backed by the HawkSpan-D MCP tool map;
- validated package manifests and package-defined presets;
- durable package-run records;
- protected `hawkspan.env` configuration with sanitized public examples;
- HawkSpan link and local-control launch agents;
- HawkSpan help videos, operator documentation, and plugin-author guidance;
- optional application plugins that call the same MCP operations;
- the unchanged HawkSpan-D messages, jobs, artifacts, routing, universal
  `run_command`, trainer adapters, and audit behavior.

## Present in C or otherwise already implemented, but deferred

- browser editors for role and directional capability profiles;
- browser-based connection editing;
- expanded package lifecycle and specialized package catalog;
- richer trainer and dashboard controls;
- release, rollback, privacy, and acceptance tooling beyond the HawkSpan-D gate;
- specialized SimpleTuner user experience.

These are retained as an implementation inventory for later work. Add them
only as bounded controls over HawkSpan-D MCP operations.

The existing config keys those editors would change are already the
authorization for the peer/command boundary: `role_profile`, `node_role`,
`features.allowed_peer_tools`, `features.enable_broad_run_command`,
`features.allow_peer_commands`, and `peer.allowed_tools` are enforced even
while the browser editors stay deferred. In `controller-worker` mode,
controller inbound and worker outbound peer-tool lists stay empty unless
explicitly configured.

## Excluded architecture

Do not import C's replacement peer-control engine, replacement SimpleTuner
controller or worker orchestration, `application-workflows` control package,
or real-pair acceptance architecture. Do not add a second scheduler,
authorization ceremony, artifact transport, or remote-control protocol.
