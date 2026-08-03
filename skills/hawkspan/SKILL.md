---
name: hawkspan
description: Coordinate trusted peer Macs through durable acknowledged messages, audited commands, guarded jobs, wakeups, and verified resumable artifacts.
---

# HawkSpan

Use HawkSpan when work must cross between two trusted Macs.

1. Call `link_status` before assuming the peer or preferred route is available.
2. Use `send_message` for durable instructions and status. Retry the same
   immutable message ID after an outage; do not create a duplicate.
3. Acknowledge inbound instructions and correlate the acknowledgement with the
   original message ID.
4. Use jobs for durable identity, progress, recovery, authorization evidence,
   and idempotency.
5. Use `peer_call_tool` for agent-to-agent operations and `run_command` for
   authorized control of software on the peer.
6. Treat the active user's instruction as authority for in-scope work.
   Deletion, publishing, and materially broader work still require explicit
   authorization.
7. Register files before sending them. Preserve the artifact ID, byte size, and
   SHA-256 in the related message or job.
8. Prefer the configured Thunderbolt route and allow the server to fall back to
   Ethernet.
9. Preserve originals until verification and explicit cleanup approval.
10. Use audit, job, message, and artifact records for recovery instead of
    conversational memory.

HawkSpan assumes both machines and local accounts are trusted by one owner.
Broad peer command execution is implemented; sandboxing and multi-user policy
are not.
