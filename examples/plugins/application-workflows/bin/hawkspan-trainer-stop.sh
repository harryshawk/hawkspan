#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
exec /usr/bin/env python3 "$script_dir/hawkspan-trainer-control.py" --action stop "$@"
