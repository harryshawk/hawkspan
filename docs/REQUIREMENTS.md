# Requirements register

## First integration

- Preserve HawkSpan-D's durable messages, acknowledgements, jobs, wakeups,
  universal command control, verified artifacts, SSH routing, trainer tools,
  and tests.
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
