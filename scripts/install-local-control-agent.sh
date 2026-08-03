#!/bin/zsh
set -euo pipefail

plugin_root=${0:A:h:h}
state_root=${HAWKSPAN_STATE_DIR:-$HOME/.hawkspan}
node_path=${HAWKSPAN_NODE:-$(command -v node)}
template_path="$plugin_root/launchd/org.hawkspan.local-control.plist.template"
target_path="$HOME/Library/LaunchAgents/org.hawkspan.local-control.plist"
uid_value=$(id -u)

mkdir -p "$state_root/audit" "$HOME/Library/LaunchAgents"
sed \
  -e "s|__NODE__|$node_path|g" \
  -e "s|__PLUGIN_ROOT__|$plugin_root|g" \
  -e "s|__STATE_ROOT__|$state_root|g" \
  "$template_path" > "$target_path"

plutil -lint "$target_path"
launchctl bootout "gui/$uid_value/org.hawkspan.local-control" 2>/dev/null || true
launchctl bootstrap "gui/$uid_value" "$target_path"
launchctl kickstart -k "gui/$uid_value/org.hawkspan.local-control"
echo "$target_path"
