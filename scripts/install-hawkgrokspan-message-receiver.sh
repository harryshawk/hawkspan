#!/bin/zsh
set -euo pipefail

state_root=${HAWKSPAN_STATE_DIR:-$HOME/.hawkgrokspan}
config_path=${HAWKSPAN_CONFIG:-$state_root/config.json}
authority_path=$state_root/installed-revision.json
label=org.hawkgrokspan.message-receiver
target_path=$HOME/Library/LaunchAgents/$label.plist

[[ $(uname -s) == Darwin ]] || { print -u2 "HawkGrokSpan launchd installer requires macOS"; exit 1; }
[[ -f $authority_path && -f $config_path && -f $target_path ]] || {
  print -u2 "activate the isolated HawkGrokSpan release before installing its receiver service"
  exit 1
}
[[ $(node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1]));process.stdout.write(String(c.surface_profile==="message-files"&&c.message_receiver?.enabled===true))' "$config_path") == true ]] || {
  print -u2 "HawkGrokSpan message receiver is not enabled in the isolated config"
  exit 1
}

uid_value=$(id -u)
mkdir -p "$state_root/audit" "$HOME/Library/LaunchAgents"
chmod 700 "$state_root" "$state_root/audit"
launchctl bootout "gui/$uid_value/$label" 2>/dev/null || true
launchctl enable "gui/$uid_value/$label"
launchctl bootstrap "gui/$uid_value" "$target_path"
launchctl kickstart -k "gui/$uid_value/$label"

deadline=$((SECONDS + 15))
while (( SECONDS < deadline )); do
  if node -e '
    const fs=require("fs");
    const path=require("path");
    const {spawnSync}=require("child_process");
    const state=process.argv[1];
    const a=JSON.parse(fs.readFileSync(path.join(state,"installed-revision.json")));
    const l=JSON.parse(fs.readFileSync(path.join(state,"audit","message-receiver-supervisor.lock","lease.json")));
    const command=spawnSync("ps",["-ww","-p",String(l.pid),"-o","command="],{encoding:"utf8"});
    const expected=path.join(path.resolve(a.active_release_root),"scripts","hawkgrokspan-message-receiver.mjs");
    const stable=path.join(path.resolve(a.stable_release_root),"scripts","hawkgrokspan-message-receiver.mjs");
    process.exit(l.managed_service===true && l.revision===a.revision &&
      path.resolve(l.script_path)===expected && command.status===0 &&
      (command.stdout.includes(l.script_path) || command.stdout.includes(stable)) &&
      command.stdout.includes("--service") ? 0 : 1);
  ' "$state_root" 2>/dev/null; then
    print "$label is running the installed HawkGrokSpan revision"
    exit 0
  fi
  sleep 1
done

print -u2 "$label did not report the installed HawkGrokSpan revision"
exit 1
