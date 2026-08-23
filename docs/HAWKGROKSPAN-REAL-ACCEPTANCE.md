# HawkGrokSpan real-node acceptance

This privacy-safe record covers two real Codex-to-Grok pairs (four HGS runtime
instances) running functional-acceptance revision
`c35a9f71dfc513cc8758337ceb13f8b8eda58ba0`, tree
`6ef6c26b5648785eb3cce8e9f4bc35f72a017389`. Private hostnames, account names,
tailnet details, SSH material, credentials, session IDs, and home paths are
intentionally omitted.

All four instances' source, package provenance, installed receipt, stable
release link, and receiver reported that exact revision before acceptance.
Extra Awake was off, the owner did not relay messages, and normal HawkSpan was
not used for Grok message or file exchange.

## Message and file exchange

Each pair completed ordinary messaging and a harmless file round trip. The
receiving Codex endpoint independently verified each byte count and SHA-256
digest before acknowledging the related result. Delivery, receipt,
verification, result, and acknowledgement remain in the HGS durable ledgers.

## Coding use

Codex sent a bounded Node.js file task. The persisted Grok Build session
returned the requested source artifact, a concise summary, and a passing
self-test. The receiving Codex endpoint independently reviewed the source,
verified the returned digest, reran the self-test, and checked a negative input
before acknowledging the result.

## Research use

Codex requested bounded primary-source technical research. Grok returned a
cited report separating sourced facts from inference. The receiving Codex
endpoint checked its length, source quality, cited claims, and returned digest
before acknowledging the result.

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

The second direct pair used isolated state, configuration, receiver identity,
plugin identity, and persisted Grok session. It completed the same real
message/file workflow plus coding and research returns without Extra Awake or
owner relay. Additional pairs should repeat this workflow with their own local
identity so that results and acknowledgements route to the requesting Codex
endpoint.
