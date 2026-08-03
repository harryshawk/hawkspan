#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec /usr/bin/env python3 "$script_dir/hawkspan-packet-builder.py" "$@"
