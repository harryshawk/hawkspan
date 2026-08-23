# Install the HawkGrokSpan Codex connector

Install HGS as a separate personal Codex plugin named `hawkgrokspan`. The
repository root plugin is normal HawkSpan and must remain separate.

## Before installation

Confirm that the HGS installed receipt, resolved `current` link, and receiver
all report the same published commit. Confirm that the configured surface is
`message-files`, the persistent Node executable exists, and the stable HGS MCP
script exists.

## Create the personal plugin

Use Codex's installed `plugin-creator` workflow to create a personal plugin with
skills, MCP, and a marketplace entry:

```sh
python3 /ABSOLUTE/PLUGIN-CREATOR/scripts/create_basic_plugin.py hawkgrokspan \
  --with-skills --with-mcp --with-marketplace
```

Set `~/plugins/hawkgrokspan/.codex-plugin/plugin.json` to:

```json
{
  "name": "hawkgrokspan",
  "version": "0.4.0+codex.LOCAL_CACHEBUSTER",
  "description": "Durable messaging and verified file exchange with Grok.",
  "author": { "name": "HawkSpan Contributors" },
  "mcpServers": "./.mcp.json"
}
```

Copy `config/hawkgrokspan-codex.mcp.example.json` to the plugin as `.mcp.json`.
Replace its placeholders with this Mac's persistent Node executable, HGS stable
release, state root, and config. Copy the complete
`skills/delegate-to-grok/` directory into the plugin. Do not copy normal
HawkSpan skills or its root MCP configuration.

## Validate and install

```sh
python3 /ABSOLUTE/PLUGIN-CREATOR/scripts/validate_plugin.py \
  "$HOME/plugins/hawkgrokspan"
python3 /ABSOLUTE/PLUGIN-CREATOR/scripts/read_marketplace_name.py
codex plugin add hawkgrokspan@personal
codex plugin list
```

For an update, copy the new skill/MCP files, refresh the plugin cachebuster with
the `plugin-creator` update script, and reinstall `hawkgrokspan@personal`.
Start a new Codex task so it loads the new plugin snapshot.

In that task, call HGS `link_status`, send one ordinary assignment to the
registered Grok target, receive its result, verify any returned file digest,
and acknowledge the result. Delivery alone is not completion.
