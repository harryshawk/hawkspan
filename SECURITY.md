# Security

## Supported posture

HawkSpan is designed for two Macs controlled by the same owner on private,
trusted links. It is not a multi-tenant remote administration product.

## Implemented

- SSH BatchMode and configurable dedicated identity file
- preferred and fallback route ordering
- durable immutable message and artifact IDs
- SHA-256 artifact verification before successful delivery
- collision-safe artifact destination names
- SQLite full synchronization and WAL journaling
- application audit records for tool and command activity
- an allowlist for tools callable through `peer_call_tool`
- application-plugin manifest, schema, role, origin, and feature-flag checks
- rejection of plugin traversal and symbolic-link candidates
- loopback-only HTML binding with a per-process request token and tool allowlist
- restrictive state/config permissions in the installation guidance

## Not implemented

- command sandboxing or a least-privilege command allowlist
- multi-user roles, quorum authorization, or policy-server enforcement
- application-plugin process or OS sandboxing
- mutual device attestation
- automatic firewall configuration
- payload encryption independent of SSH
- automatic SSH key generation, rotation, or revocation
- tamper-evident remote audit anchoring

`run_command` can execute arbitrary shell commands with the HawkSpan user's
privileges. Only use it where both machines, accounts, configuration files,
plugins, and network are trusted.

Application node roles are capability restrictions, not authenticated human
roles. Plugins execute as trusted code with the HawkSpan user's privileges.
See [the full threat model](docs/THREAT-MODEL.md).

## Recommended optional hardening

Use dedicated OS accounts and SSH keys, pin host keys, restrict `sshd` to the
private interfaces, limit filesystem permissions, encrypt both disks, disable
password SSH, rotate keys, and inspect the audit log. A future deployment may
wrap or replace `run_command` with a site-specific command policy.

## Reporting

Do not publish exploit details in a public issue before maintainers have had a
reasonable opportunity to respond. Use the repository's private vulnerability
reporting channel when it is enabled.
