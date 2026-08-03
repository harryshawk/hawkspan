# Compatibility and restriction flags

HawkSpan retains its established high-trust, symmetric behavior when these
settings are omitted. They let an owner narrow either direction of a paired
link without changing the default experience.

`role_profile` is `symmetric` by default and may be set to
`controller-worker`. That profile requires `node_role` to be `controller` or
`worker`. Unless a direction is explicitly overridden, a controller permits
outbound peer actions and a worker permits inbound peer actions. Directional
flags accept either one boolean (applied to both directions) or an object with
`inbound` and `outbound` booleans.

The complete default configuration is shown in `config/example.json`.
`allowed_peer_tools` uses `current` to retain HawkSpan's built-in allowlist;
either direction may instead be an exact array of MCP tool names.
The example intentionally leaves `features` empty: the defaults are effective
defaults, not pinned overrides. When `role_profile` or `node_role` changes,
HawkSpan clears previously configured role-sensitive directional values unless
that exact feature is included in the same atomic update. This prevents old
explicit symmetric settings from defeating the selected asymmetric role.

Command authorization can be required for every command or only commands
marked consequential. In either case `run_command` must receive the ID of a
job whose authorization has been recorded. Disabling `audit_command_content`
records a SHA-256 fingerprint instead of command text.

Artifact verification modes are:

- `always`: hash a received artifact on every import.
- `on-change` (default): reuse a prior verified result only when its recorded
  identity, size, and digest metadata are unchanged.
- `cached`: permits registered outbound artifacts to use their recorded digest
  while still checking current file size. This is a performance tradeoff and
  cannot detect same-size content changes; use it only in the stated
  same-owner, high-trust environment.

`wake_prompt_mode` may be `embedded-message` (the compatible default) or
`notification`, which tells the peer to read the durable inbox without
embedding message content in the wake prompt.

`strict_host_key_checking` defaults to true. When false, SSH uses
`accept-new`; known keys still cannot silently change, but the first
connection trusts and records an unverified key. Confirm the peer fingerprint
out of band before using this compatibility setting.

There is deliberately no `allow_verified_staging_cleanup` setting. HawkSpan's
artifact directory is the final durable store, not a disposable staging
boundary. A generic cleanup switch could delete rollback evidence or final
artifacts. Cleanup must remain a separately designed operation with a distinct
staging root and recorded authorization before such a flag can be exposed.

Agents and the localhost interface can call `get_configuration` to read all
effective values. Its `configured_features` member separately identifies only
the overrides stored in the configuration file. `update_configuration` accepts a partial `role_profile`
and/or `features` object, rejects unknown or invalid settings, atomically
preserves all unrelated configuration, and returns `restart_required: true`.

## Reset and named profiles

`reset_configuration` requires `{"confirm":true}`. It removes only the
stored `role_profile`, `node_role`, and `features` keys, thereby restoring
inherited symmetric defaults. Peer addresses, SSH settings, installation
paths, plugins, tokens, and localhost-control settings are preserved.

Named profiles are local snapshots of only those three approved configuration
keys. They are stored in `configuration-profiles.json` under the HawkSpan
state directory with generated path-safe IDs. They can never contain peer,
identity, path, token, plugin, or local-control configuration.

- `list_configuration_profiles({})` returns built-in and user profiles.
- `save_configuration_profile({"name":"Name"})` saves the current explicit
  overrides. Replacing a same-named user profile additionally requires
  `confirm_replace:true`.
- `apply_configuration_profile({"profile_id":"…","confirm":true})` atomically
  replaces only approved overrides and returns `restart_required:true`.
- `delete_configuration_profile({"profile_id":"…","confirm":true})` removes
  a user profile without changing active settings.

Each listed profile has `source` (`builtin` or `user`), `description`,
plain-language `impact`, `read_only`, and `settings` fields. Built-in profiles
cannot be replaced or deleted:

- **Current symmetric** removes feature overrides and uses symmetric operation.
- **High-value controller** blocks inbound commands and broad commands while
  permitting them outbound. Messages, acknowledgements, jobs, wakeups, and
  artifact transfer remain bidirectional; strict host checking stays enabled.
  “High-value” describes the data-sensitivity profile, not the computer's price
  or performance. Its stable ID is `builtin-high-value-controller`.
- **Compute worker** permits commands and broad commands inbound but blocks
  them outbound. Coordination and artifacts remain bidirectional; strict host
  checking stays enabled.
- **Coordination only** blocks commands and broad commands in both directions
  while keeping messages, acknowledgements, jobs, wakeups, and artifact
  transfer bidirectional.

Peer route enablement, labels, and hosts are configured separately; see
[`CONNECTIONS.md`](CONNECTIONS.md). Named capability profiles and resets never
include or alter those network settings.
