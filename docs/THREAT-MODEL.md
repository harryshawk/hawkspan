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
- immutable artifact registration and SHA-256 verification;
- namespace, state, service, and installation isolation.

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
state permissions, and reconcile external application state before retrying
interrupted work.
