# Peer connections

HawkSpan supports one or two independently configurable peer routes. A typical
two-Mac installation uses Thunderbolt as the primary route and Ethernet as the
fallback, but either route may use any private hostname or address and may be
given a human-readable label.

Machine-specific route values belong in `~/.hawkspan/hawkspan.env`; see
[`MACHINE-SETTINGS.md`](MACHINE-SETTINGS.md). Existing configurations remain
compatible. When an enable flag is omitted, a
legacy route is enabled when its corresponding host is present and disabled
when that host is absent. Thus older one-route and two-route configurations
retain their established behavior. Default labels are `Thunderbolt` and
`Ethernet`; existing `local_control.route_labels` are also retained. At least
one route must remain enabled, and every enabled route must have a nonempty
host.

Disabled routes are not pinged, contacted over SSH, or selected. `link_status`
still includes their records with `enabled:false`, `status:"disabled"`, and
null reachability fields, but redacts configured endpoints. The localhost
connection editor reveals exact values only when needed for editing. Automatic
fallback is available only when both routes are
enabled. With one route enabled, that route is simply the active connection.

The narrow configuration tools are:

- `get_connection_configuration({})` returns
  `routes.primary` and `routes.fallback`, each with `enabled`, `label`, and
  `host`, plus the derived `automatic_fallback` value.
- `update_connection_configuration({"routes":{...},"confirm":true})` accepts
  partial route updates, validates the complete result, atomically rewrites
  the mode-`600` `hawkspan.env` file,
  preserves unrelated settings, and returns `restart_required:true`.

Connection settings are deliberately excluded from named capability profiles.
Saving, applying, deleting, or resetting a role/feature profile cannot change
route enablement, labels, or hosts.
