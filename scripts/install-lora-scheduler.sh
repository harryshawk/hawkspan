#!/bin/zsh
set -euo pipefail

release_root="${0:A:h:h}"
active_root=${HAWKSPAN_ACTIVE_RELEASE_ROOT:?HAWKSPAN_ACTIVE_RELEASE_ROOT is required}
service_root=${HAWKSPAN_SERVICE_ROOT:?HAWKSPAN_SERVICE_ROOT is required}
[[ ${release_root:A} == ${active_root:A} ]] || { print -u2 "installer release does not match active release"; exit 1; }
state_root="${HAWKSPAN_STATE_DIR:-$HOME/.hawkspan}"
label="org.hawkspan.lora-scheduler"
target="$HOME/Library/LaunchAgents/$label.plist"
template="$release_root/launchd/$label.plist.template"

mkdir -p "$state_root" "$HOME/Library/LaunchAgents"
mkdir -p "$state_root/lora-scheduler"
test -e "$state_root/lora-scheduler/lora-jobs.json" || \
  cp "$release_root/config/lora-jobs.json" "$state_root/lora-scheduler/lora-jobs.json"
test -e "$state_root/lora-scheduler/lora-queue-policy.json" || \
  cp "$release_root/config/lora-queue-policy.json" \
    "$state_root/lora-scheduler/lora-queue-policy.json"
chmod +x "$release_root/scripts/lora-scheduler.py"
temporary="$target.tmp.$$"
trap 'rm -f "$temporary"' EXIT
sed -e "s|__PLUGIN_ROOT__|$service_root|g" \
  -e "s|__STATE_ROOT__|$state_root|g" \
  "$template" > "$temporary"
plutil -lint "$temporary"
mv "$temporary" "$target"
trap - EXIT
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl enable "gui/$(id -u)/$label"
launchctl bootstrap "gui/$(id -u)" "$target"
echo "Installed $label"
