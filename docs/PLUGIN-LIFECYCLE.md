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
