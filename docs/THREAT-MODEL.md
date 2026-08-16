# High-trust threat model

## Protected assets

HawkSpan carries commands, application operations, messages, job
authorization evidence, artifacts, configuration, and audit records. It can
act with the local HawkSpan user's privileges on both paired Macs.

## Trust assumptions

Both Macs, their owner, local OS accounts, SSH configuration, HawkSpan
configuration, and every enabled application plugin are trusted. Private links
and SSH reduce network exposure but do not make a compromised peer safe.
Node roles and feature flags are deployment restrictions, not user identities
or a security boundary against a malicious administrator.

## Threats addressed

- manifest and input validation before plugin dispatch;
- rejection of plugin path traversal and symbolic links;
- explicit node roles, origins, feature flags, and operation restrictions;
- loopback-only HTML binding, per-process request token, and HTML allowlist;
- peer tool allowlisting and BatchMode SSH;
- durable lifecycle records and interrupted-run recovery;
- dedicated workspace-bounded Codex wake receivers that are not held open by
  the desktop app;
- immutable artifact registration and SHA-256 verification;
- namespace, state, service, and installation isolation.

For HawkGrokSpan, the Grok VM is trusted to exchange messages and selected
files but is not trusted with the M2/M4 control surface. The server therefore
removes command, peer-tool, job, queue, application-plugin, trainer, and wake
operations from discovery and dispatch; requires bounded artifact roots; and
requires an exclusive pinned-host SSH configuration. Prompt instructions and
an MCP client's displayed tool list are not treated as the enforcement layer.

## Residual risks

Plugins are native JavaScript loaded into the server process and are not
sandboxed. A malicious plugin, peer, local account, or broadly authorized
command can read or change anything available to the HawkSpan user. Plugin
input schemas do not correct unsafe plugin implementation. Loopback services
can be reached by other local processes. Audit rows are not tamper-proof.
Cancellation is cooperative, and an interrupted external operation may have
partially completed.

Install only reviewed plugins, keep allowlists narrow, use dedicated accounts
and SSH identities where practical, pin host keys, protect configuration and
state permissions, keep wake receivers in dedicated directories with unrelated
writable roots removed, and reconcile external application state before
retrying interrupted work.

Grok's own built-in tools remain outside HawkGrokSpan's control. The restricted
profile limits only what the VM can reach through HawkGrokSpan, so the VM and
its Grok sandbox remain separate trust decisions.
