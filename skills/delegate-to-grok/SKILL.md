---
name: delegate-to-grok
description: Delegate a bounded coding, research, review, or file task from Codex to a registered Grok Build worker through HawkGrokSpan, then receive and verify the result. Use when the user asks Codex to ask Grok, send work to Grok, use Grok as a coder or researcher, compare Codex with Grok, or hand files to or from Grok.
---

# Delegate to Grok

Use only the `hawkgrokspan` message and artifact tools. Do not use normal
HawkSpan for Grok work.

1. Call HGS `link_status`. If the private route is not ready, report the failed
   layer; do not invent another transport.
2. Define one bounded assignment with a clear deliverable and acceptance
   condition. Address operational work to the requesting Codex endpoint and
   reserve the human owner for decisions, authorization, login, or physical
   action.
3. For input files, use only the configured HGS exchange root, register each
   artifact, send it, and include its artifact ID and SHA-256 in the assignment.
4. Omit `recipient` so HGS uses the configured peer node, set `target_bot_id`
   to the registered `grok-primary` target, and state the requesting endpoint's
   return target in the assignment. Ordinary HGS messages notify the receiver
   automatically; do not use Extra Awake.
5. Treat delivery as mailbox receipt, not completion. Wait for durable
   acknowledgement and a result message. Import returned artifacts and
   independently verify their SHA-256.
6. For coding, require a returned patch or changed files, a concise summary,
   and the command/result used to check the change. Review before applying or
   committing it locally.
7. For research, require direct source URLs and a clear separation between
   sourced facts and inference.
8. Acknowledge the result only after the requested work and returned files are
   verified.

HawkGrokSpan authorizes message and verified file exchange, not remote shell,
deployment, credential transfer, network changes, or normal HawkSpan control.
