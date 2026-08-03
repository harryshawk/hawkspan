# Coexistence and isolation

HawkSpan is an independent service. Its defaults and supplied installer use
only the `.hawkspan` state directory, the `org.hawkspan.link-agent` launch
service label, HawkSpan configuration, and HawkSpan-selected SSH identity.

An installation must not reuse, migrate, inspect, stop, modify, or delete the
state, service, namespace, credentials, task identifiers, or private message
contents of Mac Link or another peer-link tool. Coexistence checks are bounded
to HawkSpan's own public paths and labels; the test suite does not connect to
or enumerate another installed service.

Use a dedicated SSH identity and explicit HawkSpan remote paths. Do not point
`remote_inbox`, `remote_artifacts`, `remote_audit`, or `remote_call_tool` at
another product's directories. Uninstalling HawkSpan must remove or archive
only HawkSpan-owned files and its own launch service.

The supported core uninstaller enforces that boundary by naming only
`org.hawkspan.link-agent` and `org.hawkspan.local-control` and by archiving only
their launch plists plus the configured HawkSpan state root. Preview mode is
the default; actual changes require `--confirm`.
