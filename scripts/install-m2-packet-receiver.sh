#!/bin/zsh
set -euo pipefail

release_root=${0:A:h:h}
active_root=${HAWKSPAN_ACTIVE_RELEASE_ROOT:?HAWKSPAN_ACTIVE_RELEASE_ROOT is required}
service_root=${HAWKSPAN_SERVICE_ROOT:?HAWKSPAN_SERVICE_ROOT is required}
[[ ${release_root:A} == ${active_root:A} ]] || { print -u2 "installer release does not match active release"; exit 1; }
state_root=${HAWKSPAN_STATE_DIR:-$HOME/.hawkspan}
node_path=${HAWKSPAN_NODE:-$(command -v node)}
template_path="$release_root/launchd/org.hawkspan.packet-receiver.plist.template"
target_path="$HOME/Library/LaunchAgents/org.hawkspan.packet-receiver.plist"
uid_value=$(id -u)

mkdir -p "$state_root/audit" "$HOME/Library/LaunchAgents"
temporary="$target_path.tmp.$$"
trap 'rm -f "$temporary"' EXIT
sed \
  -e "s|__NODE__|$node_path|g" \
  -e "s|__PLUGIN_ROOT__|$service_root|g" \
  -e "s|__STATE_ROOT__|$state_root|g" \
  "$template_path" > "$temporary"

plutil -lint "$temporary"
mv "$temporary" "$target_path"
trap - EXIT
launchctl bootout "gui/$uid_value/org.hawkspan.packet-receiver" 2>/dev/null || true
launchctl enable "gui/$uid_value/org.hawkspan.packet-receiver"
launchctl bootstrap "gui/$uid_value" "$target_path"
launchctl kickstart -k "gui/$uid_value/org.hawkspan.packet-receiver"
echo "$target_path"
