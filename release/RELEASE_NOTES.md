# HawkSpan 0.1.0

HawkSpan 0.1.0 is the first public release of the macOS peer-agent link for two
trusted Macs controlled by the same owner.

## Included

- durable messages and correlated acknowledgements;
- guarded jobs, wakeups, audit records, and resumable SHA-256-verified artifacts;
- preferred and fallback private routes;
- audited peer command and tool calls;
- validated optional application plugins;
- a loopback-only HTML control surface;
- agent-assisted installation, upgrade, rollback, and removal guidance; and
- optional local SimpleTuner workflow examples.

## Installation

Download the attached verified source archive, verify it against the attached
`SHA256SUMS`, extract it to a stable path on each Mac, and run:

```sh
zsh scripts/check-release.sh
```

Continue with `INSTALL.md` only after the complete release gate passes.

## Known limitations

- HawkSpan assumes two trusted Macs, one owner, private networking, and trusted
  local users.
- `run_command` executes with the HawkSpan user's privileges and does not
  provide command sandboxing or a least-privilege command policy.
- Multi-user roles, mutual device attestation, automatic firewall management,
  automatic SSH-key lifecycle, and payload encryption independent of SSH are
  not implemented.
- Application plugins execute as trusted local code and must be reviewed before
  installation.
- SimpleTuner is an optional, separately installed local workflow; HawkSpan does
  not install or modify it automatically.

Read `SECURITY.md`, `INSTALL.md`, and `docs/THREAT-MODEL.md` before deployment.

