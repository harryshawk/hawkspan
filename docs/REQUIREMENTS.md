# Requirements register

## First integration

- Preserve HawkSpan-D's durable messages, acknowledgements, jobs, wakeups,
  configured directional command control, verified artifacts, SSH routing,
  trainer tools, and tests.
- Fail closed when remote wake lacks an exact receiver UUID, absolute Codex
  executable, absolute dedicated receiver directory, or workspace-write
  sandbox; clear unrelated writable roots on the generated resume command.
- Use HawkSpan's own sanitized state, configuration, examples, and public
  namespace without changing HawkSpan-D behavior.
- Add a loopback-only HTML surface that calls the same MCP tool map.
- Add optional validated application packages and durable package-run status.
- Limit first-release presets to selecting operations from their own package.
- Keep peer addresses, paths, identities, and other machine settings in a
  protected local environment file, never in the public repository.
- Test HawkSpan-D compatibility once and test only HawkSpan's added environment,
  package, preset, and web behavior.

## Deferred

See `docs/DEFERRED-FEATURES.md`. Deferred behavior is not a first-integration
requirement and must not be presented as implemented.

## HawkGrokSpan

- Reuse the exact HawkSpan source and release identity with separate
  `~/.hawkgrokspan` state; do not fork the transport or join the M2/M4 pair.
- Expose and dispatch only link, durable-message, acknowledgement, and
  verified-artifact operations.
- Keep local control, application plugins, peer calls, commands, jobs, queues,
  training, and wake disabled and unreachable through the restricted MCP
  surface.
- Restrict outgoing files to explicit real exchange roots and reject symlink
  escape, malformed manifests, and non-regular received payloads.
- Require a dedicated owner-only SSH identity, a dedicated pinned
  `known_hosts`, strict checking, and no global-host fallback.
- Package the Grok side with exact commit and SHA-256 evidence; configure no
  Grok or GitHub credential on the owner's behalf.
- Accept the deployment only after real bidirectional messages,
  acknowledgements, harmless files, matching digests, and a rejected
  outside-root transfer pass between M2 and the VM.
