#!/bin/zsh
set -euo pipefail
exec /usr/bin/python3 \
  "${0:A:h}/m4-trainer-control.py" \
  --action package "$@"
