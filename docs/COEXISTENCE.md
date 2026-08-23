# Coexistence and isolation

HawkSpan is an independent service. Its defaults and supplied installer use
only the `.hawkspan` state directory, the `org.hawkspan.link-agent` launch
service label, HawkSpan configuration, and HawkSpan-selected SSH identity.

An installation must not reuse, migrate, inspect, stop, modify, or delete the
state, service, namespace, credentials, task identifiers, or private message
contents of HawkSpan-D or another peer-link tool. Coexistence checks are bounded
to HawkSpan's own public paths and labels; the test suite does not connect to
or enumerate another installed service.

Use a dedicated SSH identity and explicit HawkSpan state and delivery paths.
Do not point `remote_inbox`, `remote_artifacts`, or `remote_audit` at another
product's directories. The peer executable path is discovered from the peer's
HawkSpan installed-revision authority and must not be configured statically.
Uninstalling HawkSpan must remove or archive
only HawkSpan-owned files and its own launch service.

Core install and uninstall automation is deferred. Until it is added and
tested, do not claim that D can remove an installed core service automatically.

HawkGrokSpan is the supported second-instance pattern for the owner's trusted
Grok VM. It shares the reviewed source code but uses `~/.hawkgrokspan`, a
distinct MCP registration, a dedicated SSH identity and `known_hosts`, and a
messages/files-only surface. It must not read or write the existing M2/M4
HawkSpan state or credentials. See [HAWKGROKSPAN.md](HAWKGROKSPAN.md).
