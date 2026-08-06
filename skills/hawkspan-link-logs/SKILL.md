---
name: hawkspan-link-logs
description: Read and interpret HawkSpan's live Thunderbolt and Ethernet connection logs and active link configuration. Use for link failures, timeouts, fallback, recovery, route selection, or requests to inspect TB/TB5 evidence without changing system or HawkSpan state.
---

# HawkSpan Link Logs

Perform read-only diagnosis. Do not restart agents, alter networking, edit
`hawkspan.env`, send test messages, or use readiness-test/preflight captures.

## Read the live evidence

Use the production logs on each Mac:

```bash
tail -n 200 ~/.hawkspan/audit/link-agent.log
tail -n 100 ~/.hawkspan/audit/link-agent-error.log
rg -n 'Operation timed out|all routes failed|"delivery"|"host"' \
  ~/.hawkspan/audit/link-agent.log | tail -n 200
```

Summarize actual route attempts and outcomes:

```bash
sed 's/^[^ ]* //' ~/.hawkspan/audit/link-agent.log |
  jq -r '[.messages[]?.delivery.attempts[]?,.artifacts[]?.delivery.attempts[]?] |
  .[] | [.host,.stage,(.status // ""),(.error // "")] | @tsv' |
  sort | uniq -c
```

Read the peer log over the fallback route when the primary route is suspect:

```bash
ssh -i <HAWKSPAN_SSH_IDENTITY> -o BatchMode=yes -o IdentitiesOnly=yes \
  -o ConnectTimeout=15 <HAWKSPAN_PEER_USER>@<HAWKSPAN_FALLBACK_HOST> \
  'tail -n 200 ~/.hawkspan/audit/link-agent.log'
```

Log timestamps are UTC. Distinguish power-off intervals, where both routes fail,
from a primary-only failure where Ethernet remains available. Report the first
failure, last failure, recovery, successful route, and whether fallback actually
completed a delivery.

## Read active controls

```bash
rg -n '^HAWKSPAN_(PRIMARY|FALLBACK|SSH_IDENTITY|REMOTE_AUDIT|READINESS_|LINK_)' \
  ~/.hawkspan/hawkspan.env
```

- `PRIMARY_*`: preferred route label, local address, peer address, and enable flag.
- `FALLBACK_*`: fallback route equivalents.
- `SSH_IDENTITY` and `REMOTE_AUDIT`: peer access and remote log location.
- `READINESS_*_TIMEOUT_MS`: per-layer bounds for local configuration, ping, SSH
  port, SSH login, HawkSpan agent, and trainer.
- `READINESS_TOTAL_TIMEOUT_MS`: total readiness bound.
- `READINESS_RETRY_DELAYS_MS`: layered startup/readiness retry sequence.
- `LINK_OPERATION_RETRY_DELAYS_MS`: same-route complete application-operation retries completed
  before HawkSpan advances from Thunderbolt to Ethernet.
- `LINK_OPERATION_ATTEMPT_TIMEOUT_MS`: maximum wall time for one application operation attempt so a stalled primary route cannot consume the entire fallback cycle.
- `LINK_CONNECT_TIMEOUT_MS` and `LINK_CYCLE_TIMEOUT_MS`: per-attempt and whole-cycle bounds.
- `LINK_SERVER_ALIVE_INTERVAL_SECONDS` and `LINK_SERVER_ALIVE_COUNT_MAX`: SSH keepalive controls.
- `LINK_PRIMARY_REPROBE_MS`: delay before a primary-route reprobe after fallback.

## Apple references

Apple documents Thunderbolt Bridge as IP networking between two Macs. It uses
DHCP by default and also supports manually configured IPv4 addresses:
https://support.apple.com/guide/mac-help/mchld53dd2f5/mac

Apple documents inspecting, activating, and ordering Thunderbolt and other
network services in Network settings:
https://support.apple.com/guide/mac-help/mchlee7b367f/mac

Apple documents renewing a DHCP lease as a possible response to address issues:
https://support.apple.com/guide/mac-help/mchlp1545/mac

Treat those pages as configuration guidance, not an Apple guarantee of link
uptime. Separate observed HawkSpan evidence from any inference about macOS.
