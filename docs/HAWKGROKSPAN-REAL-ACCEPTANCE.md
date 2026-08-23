# HawkGrokSpan real-node acceptance

This privacy-safe record covers a real Codex-to-Grok peer running HGS release
`02cfbe0e3f0246b3e3f930e18e05a7e70472350a`, tree
`ceaeae841154fe7a8b5b1d345ccd19cfe305c0ab`. Private hostnames, account names,
tailnet details, SSH material, credentials, session IDs, and home paths are
intentionally omitted.

Both endpoints' source, package provenance, installed receipt, stable release
link, and receiver reported that exact revision. Extra Awake was off and normal
HawkSpan was not used for Grok work.

## Message and file exchange

One harmless file traveled in each direction. The receiver independently
verified each byte count and SHA-256 digest before acknowledging the related
message. Delivery, receipt, verification, result, and acknowledgement remain in
the HGS durable ledgers.

## Coding use

Codex sent a small source fixture with one incorrect business-rule comparison.
The persisted Grok Build session returned a corrected file, a concise summary,
and a passing bounded self-test. Codex independently reviewed the changed line,
verified the returned digest, and reran the same check before acknowledging it.

## Research use

Codex requested current primary-source research on Grok Build persistence, MCP
configuration, session behavior, and authentication recovery. Grok returned a cited
report separating sourced facts from inference. Codex checked the cited official
pages before acknowledging the result.

## Power and update recovery

A later Mac power cycle preserved the installed HGS receipt, stable link,
receiver, databases, and already-delivered message/file records. Both private
routes returned ready, so the existing durable message IDs were resumed rather
than replaced.

A Grok Computer Update was materially different: home files persisted, while
OpenSSH/`sshd`, `rsync`, userspace Tailscale processes, the TCP-22 Serve mapping,
and the VM SSH host key required inspection or restoration. Recovery restored
only the missing components, resumed the persisted Grok session, restarted the
HGS receivers, and repeated bidirectional use.

Every additional direct Codex/Grok pair must have its own isolated state and
repeat the same real workflow; this record does not imply acceptance for a pair
that has not completed it.
