# Real-pair acceptance

The real-pair acceptance harness verifies an installed pair without putting
machine-specific installation data in the repository or its receipt. Its default mode
is an inert preflight plan:

```sh
node scripts/real-pair-acceptance.mjs
```

This mode does not load an adapter, read HawkSpan configuration or state,
inspect services, or access the network.

## Public code and local values

HawkSpan is one fully public product. Real-pair adapter code must be sanitized
public HawkSpan code or part of a sanitized public plugin; it is not a private
HawkSpan component. Machine-specific values belong only in the agent-managed
`~/.hawkspan/hawkspan.env`, outside Git, with mode `600` or read-only mode `400`.

The environment file must be parsed as data using a documented key allowlist.
It must never be sourced or evaluated as shell code. Quotes, spaces,
backslashes, dollar signs, and shell-looking text are parsed as literal data.
Unknown keys, malformed lines, duplicate keys, and malformed types are
rejected. The parser also requires a regular, current-user-owned file;
symlinks and modes other than `600` or `400` are rejected. Neither the adapter nor the
runner may echo the file, its values, or raw errors.

The runner never calls `process.loadEnvFile`, never sources the file, and never
adds its values to global `process.env`. It starts the public adapter as a child
with only a fixed `PATH`, `LANG`, and `LC_ALL`, then supplies a private config
object in a single JSON request on standard input. The adapter writes one JSON
response on standard output and exits. Requests have this shape:

```js
{ operation: "preflight", config: { /* strictly parsed keys */ } }
{ operation: "run-check", check_id: "mcp-list-call", context: {}, config: {} }
```

The runner deliberately ignores every adapter value except the fixed boolean
assertions defined in `scripts/real-pair-acceptance-lib.mjs`. Adapter errors are
reported only as `adapter-error`; their text is suppressed. The artifact check
receives two small public fixture strings through `context.fixtures`.

After an agent has created and permission-checked `hawkspan.env`, and the owner
authorizes the real-machine checks, run the public adapter supplied by the
release or a sanitized public plugin:

```sh
HAWKSPAN_REAL_PAIR_AUTHORIZED=YES node scripts/real-pair-acceptance.mjs \
  --execute --adapter ./scripts/hawkspan-real-pair-adapter.mjs \
  --receipt ./new-receipt.json \
  --env-file ~/.hawkspan/hawkspan.env
```

The receipt target must not already exist. The runner creates it with mode
`600`. Keep `hawkspan.env` and detailed working logs outside Git. The adapter
path selects public code; it is not where machine-specific values belong.

The bundled adapter uses HawkSpan's public MCP and `call-tool.mjs` interfaces;
it never calls another peer-link product. Its SimpleTuner check calls only the
worker plugin's read-only `training_local_process_status` operation and confirms
that an absolute local trainer root was configured. It does not claim package
installation or version proof and never starts, checkpoints, or stops training.
The coexistence assertion verifies that the adapter's configured state,
configuration, evidence, and executable interface paths remain confined to
HawkSpan-owned roots. It deliberately does not inspect another product to prove
non-interference.

The rollback assertion does not require Git metadata at runtime. It verifies
the installed public tree against `release/release-manifest.json`, then requires
the exact same `tree-sha256:` release ID in the owner-only
`~/.hawkspan/installed-revision.json`. That record must be a regular,
current-user-owned mode-`600` file with exactly `schema_version` and
`release_id`; missing, altered, over-permissive, or legacy commit-only records
fail closed. Full Git-history provenance remains a separate mandatory release
gate whenever the candidate is a Git worktree.

## Owner-assisted fallback evidence

The fallback assertion cannot be enabled with a boolean. The owner must observe
a real primary interruption and restoration while an agent records three
phases through HawkSpan's public `link_status` interface:

```sh
node scripts/record-owner-assisted-fallback.mjs --phase baseline \
  --evidence ~/.hawkspan/acceptance/fallback-evidence.json
# Owner interrupts only the primary physical route.
node scripts/record-owner-assisted-fallback.mjs --phase interrupted \
  --evidence ~/.hawkspan/acceptance/fallback-evidence.json
# Owner restores the primary physical route.
node scripts/record-owner-assisted-fallback.mjs --phase restored \
  --evidence ~/.hawkspan/acceptance/fallback-evidence.json
```

Add the absolute evidence path as `HAWKSPAN_REAL_PAIR_FALLBACK_EVIDENCE` in
`hawkspan.env`. The owner-only, non-symlink file contains fixed booleans and
phase labels only. Missing, reordered, repeated, or contradictory observations
fail closed. An agent must never manufacture this evidence.

## Receipt contract

The public receipt contains only:

- schema version, execution mode, and overall pass/fail;
- each fixed check ID and pass/fail state;
- named boolean assertions; and
- the fixed failure codes `preflight-failed` or `adapter-error`.

It never contains usernames, hostnames or IP addresses, personal paths, task
or message IDs, message bodies, commands, workload data, digests, adapter
errors, environment values, or timestamps that could correlate a machine run. Validate the harness
itself with:

```sh
node scripts/test-real-pair-acceptance.mjs
node scripts/test-hawkspan-real-pair-adapter.mjs
```

The machine-readable contract is
`docs/schemas/real-pair-receipt.schema.json`. The runner also applies the same
closed-key validation before writing a receipt.

The executable and manual mappings are in
`features/real-pair-acceptance.feature`. A passing synthetic harness test does
not claim that a real pair passed; only an explicitly authorized receipt from
reviewed public adapter code using the local machine environment can make that
claim.

Full execution still requires HawkSpan installed and configured on both Macs,
the reviewed SimpleTuner plugin on the worker, a recorded installed release ID,
running HawkSpan services, and the owner's fallback-cable sequence. The fake
adapter tests prove deterministic logic and privacy behavior only.
