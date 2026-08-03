# Private machine settings

HawkSpan is one fully public product, including sanitized optional plugins.
Only each installation's values, credentials, state, and workload data remain
local. Behavioral configuration belongs in `~/.hawkspan/config.json`;
machine-specific values belong in `~/.hawkspan/hawkspan.env`.

Copy `config/hawkspan.env.example`, replace its documentation placeholders,
and set mode `600` (read-only mode `400` is also accepted). The file must be a regular non-symbolic-link file owned by
the current user. HawkSpan reads it once at startup with a strict parser that
accepts only documented names and single-line Node-compatible `NAME=value`
entries. Quotes, spaces, backslashes, dollar signs, and shell-looking characters
are ordinary literal data; they are never executed or interpolated. Unknown or
duplicate names, unsafe modes, oversized values, and malformed types are rejected. HawkSpan never uses shell
`source`, `eval`, or global environment loading for this file.

The file stores node and peer identifiers, peer username, enabled routes,
route labels and addresses, remote HawkSpan paths, an optional task ID, the
fixed local-control port, and the path to a dedicated SSH identity. SSH private
key contents never belong in `hawkspan.env`; keep that key in its own mode-`600`
file.

Optional SimpleTuner worker values also belong in this same file: approved
inbox, dataset, recipe, output, state, disk, runtime, and log roots; the local
SimpleTuner installation root; and the reviewed trainer command paths. The
public plugin configuration stores only allowlisted environment-name
references. These values never belong in `config.json`, a preset, or a separate
plugin dotenv.

Real-pair fallback acceptance may additionally reference
`HAWKSPAN_REAL_PAIR_FALLBACK_EVIDENCE`. It must point inside the HawkSpan state
root to the owner-only evidence created by the public recorder after observing
baseline, interrupted-primary, and restored-primary route states. It contains
no addresses or timestamps and is never a substitute for the physical test.

Resolved values stay in HawkSpan's private in-process configuration object.
Exported status and diagnostics redact endpoints, paths, and loaded values.
The localhost Configuration screen may reveal route values when the owner
opens the connection editor because editing them requires the exact value.
Spawned processes receive a minimal explicit environment allowlist rather than
the parent process's full environment.

Connection edits made through the localhost screen atomically rewrite
`hawkspan.env` at mode `600`; role profiles and application quick starts never
copy resolved machine values into `config.json`.

`.gitignore` excludes real `.env` files as defense in depth. The release and
history gates independently reject any real `*.env` path or archive member;
only `*.env.example` placeholder files may ship.
