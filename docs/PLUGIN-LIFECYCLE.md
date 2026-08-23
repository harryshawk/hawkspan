# Plugin installation and lifecycle

## Install

Inspect the plugin source and manifest before installation. For a trusted local
directory:

```sh
HAWKSPAN_STATE_DIR=/path/to/test-home \
  node scripts/install-application-plugin.mjs /path/to/plugin-id
```

Without `HAWKSPAN_STATE_DIR`, the destination is
`~/.hawkspan/plugins/<plugin-id>`. Installation validates the source, rejects
symbolic links and traversal, copies into a private staging directory,
revalidates the copy, and atomically renames it. It will not replace an
existing plugin.

Restart HawkSpan and inspect `application_plugin_status`. Enable or narrow the
plugin in `config.json`, then exercise a harmless read-only operation before
consequential work.

If the reviewed manifest declares quick-start presets, call
`list_application_presets` and `preview_application_preset` before applying
one with explicit confirmation. Restart after apply or reset, then repeat the
status and harmless-operation checks. Presets never replace application
configuration or installation details.

## Upgrade

Stop the HawkSpan process, uninstall the old version, install the reviewed new
version, adjust configuration if its operations changed, restart, and verify
the reported version. Keep plugin-owned application outputs until upgrade
recovery has been verified.

### If the Codex task remains read-only

A HawkSpan status check may open the local SQLite store and perform a harmless
initialization write. If an existing Codex task still reports that
`~/.hawkspan` or `spool.sqlite3` is read-only after Full Access is selected,
stop that task. The failure does not by itself indicate a damaged packet,
database, or HawkSpan installation.

Start a new Codex task after selecting Full Access, provide the same reviewed
packet path and expected SHA-256 digest, and state whether the earlier task
made any changes. The new task must verify the packet again before running the
exact reviewed local installer. A packet verified only with SHA-256 is hashed,
not cryptographically signed; do not describe it as signed unless a separate
signature was actually verified.

Do not work around a read-only task by using Computer Use to drive Terminal,
changing filesystem permissions, sending a peer `run_command`, or searching
for an undocumented HawkSpan service/IPC installation path. Those paths bypass
the reviewed local installation boundary and may violate an intentional
controller/worker command restriction. If a new writable task cannot be
started, the owner may instead run the exact reviewed installer directly in a
local Terminal session.

After installation, verify the unchanged HawkSpan core revision,
`application_plugin_status`, one harmless local plugin operation, and one
allowed peer dispatch of that operation. Stop if the plugin is rejected or any
revision differs from the reviewed handoff.

## Disable and uninstall

Set `application_plugins.entries.<id>.enabled` to `false` and restart to
disable loading without moving files. To uninstall:

```sh
node scripts/uninstall-application-plugin.mjs plugin-id
```

Uninstall moves only that exact validated ID from `plugins/` to a timestamped
directory under `uninstalled-plugins/`, making the operation recoverable. It
does not delete plugin artifacts, HawkSpan jobs, audit rows, SSH
configuration, or external application data.

## Failure and recovery

Failed and cancelled calls remain in durable run history. A run that was active
when the process stopped is changed to `interrupted` at next start. That state
does not prove the external application stopped or rolled back. Reconcile the
application, HawkSpan job, and registered artifacts before retrying.
