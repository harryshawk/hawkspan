#!/bin/zsh
set -euo pipefail

active_root=${HAWKSPAN_ACTIVE_RELEASE_ROOT:?run activate-release.mjs before installing services}
service_root=${HAWKSPAN_SERVICE_ROOT:?stable service root is required}
plugin_root=${0:A:h:h}
[[ ${plugin_root:A} == ${active_root:A} ]] || { print -u2 "installer release does not match active release"; exit 1; }
state_root=${HAWKSPAN_STATE_DIR:-$HOME/.hawkspan}
node_path=${HAWKSPAN_NODE:-$(command -v node)}
template_path="$active_root/launchd/org.hawkspan.local-control.plist.template"
target_path="$HOME/Library/LaunchAgents/org.hawkspan.local-control.plist"
uid_value=$(id -u)

mkdir -p "$state_root/audit" "$HOME/Library/LaunchAgents"
temporary_path=$(mktemp "$target_path.tmp.XXXXXX")
trap 'rm -f "$temporary_path"' EXIT
sed \
  -e "s|__NODE__|$node_path|g" \
  -e "s|__PLUGIN_ROOT__|$service_root|g" \
  -e "s|__STATE_ROOT__|$state_root|g" \
  "$template_path" > "$temporary_path"

plutil -lint "$temporary_path"
chmod 644 "$temporary_path"
mv -f "$temporary_path" "$target_path"
trap - EXIT
launchctl bootout "gui/$uid_value/org.hawkspan.local-control" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$uid_value" "$target_path" || {
  sleep 1
  launchctl bootstrap "gui/$uid_value" "$target_path"
}
launchctl enable "gui/$uid_value/org.hawkspan.local-control"
launchctl kickstart -k "gui/$uid_value/org.hawkspan.local-control"
echo "$target_path"
