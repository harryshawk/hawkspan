#!/bin/zsh
set -euo pipefail

state_root=${HAWKSPAN_STATE_DIR:-$HOME/.hawkspan}
archive_root=${HAWKSPAN_UNINSTALL_ARCHIVE_DIR:-$HOME/.hawkspan-uninstalled}
launch_agents_root=${HAWKSPAN_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
launchctl_command=${HAWKSPAN_LAUNCHCTL:-launchctl}
uid_value=${HAWKSPAN_UID:-$(id -u)}
mode=dry-run

usage() {
  cat <<'EOF'
usage: scripts/uninstall-hawkspan.sh [--dry-run | --confirm]

Preview is the default. --confirm stops only HawkSpan's two user services and
moves HawkSpan's launch plists and state into a recoverable timestamped archive.
EOF
}

case ${1:-} in
  ""|--dry-run) ;;
  --confirm) mode=confirm ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }

if [[ -L "$state_root" ]]; then
  print -u2 "refusing symbolic-link HawkSpan state directory: $state_root"
  exit 1
fi
state_root=${state_root:A}
archive_root=${archive_root:A}
launch_agents_root=${launch_agents_root:A}
home_root=${HOME:A}
[[ "$state_root" != "/" && "$state_root" != "$home_root" ]] || {
  print -u2 "refusing unsafe HawkSpan state path: $state_root"
  exit 1
}
[[ "$archive_root" != "$state_root" && "$archive_root" != "$state_root"/* ]] || {
  print -u2 "archive directory must be outside the HawkSpan state directory"
  exit 1
}

labels=(org.hawkspan.link-agent org.hawkspan.local-control)
plist_paths=(
  "$launch_agents_root/org.hawkspan.link-agent.plist"
  "$launch_agents_root/org.hawkspan.local-control.plist"
)

print "HawkSpan core uninstall ${mode}"
for label in $labels; do print "stop gui/$uid_value/$label"; done
for plist_path in $plist_paths; do
  [[ -e "$plist_path" ]] && print "archive $plist_path"
done
[[ -e "$state_root" ]] && print "archive $state_root"

if [[ "$mode" == dry-run ]]; then
  print "No changes made. Re-run with --confirm to perform this recoverable uninstall."
  exit 0
fi

timestamp=${HAWKSPAN_UNINSTALL_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
destination="$archive_root/$timestamp"
[[ ! -e "$destination" ]] || {
  print -u2 "archive destination already exists: $destination"
  exit 1
}
mkdir -p "$destination/LaunchAgents"
chmod 700 "$archive_root" "$destination" "$destination/LaunchAgents"

for label in $labels; do
  "$launchctl_command" bootout "gui/$uid_value/$label" 2>/dev/null || true
done
for plist_path in $plist_paths; do
  [[ -e "$plist_path" ]] && mv "$plist_path" "$destination/LaunchAgents/"
done
[[ -e "$state_root" ]] && mv "$state_root" "$destination/state"

cat > "$destination/RESTORE.txt" <<EOF
HawkSpan recoverable uninstall archive

To restore state:
  mv "$destination/state" "$state_root"

To restore launch plists:
  mv "$destination/LaunchAgents/"*.plist "$launch_agents_root/"

After reviewing the restored configuration, reinstall or bootstrap HawkSpan's
services using the installation guide. Nothing in this archive is deleted by
the uninstaller.
EOF
chmod 600 "$destination/RESTORE.txt"
print "HawkSpan core files archived at $destination"
