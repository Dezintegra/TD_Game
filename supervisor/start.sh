#!/usr/bin/env sh
# =====================================================================
#  Pipeline supervisor launcher for Unix-like systems.
#
#  ASCII only, to match start.cmd: every Russian message lives in
#  bin/launch.mjs, which Node always reads as UTF-8. Keeping the text
#  out of the wrappers keeps their encoding a non-issue.
#
#  Usage:
#    ./start.sh                run and watch
#    ./start.sh --shadow       dry run: decide and print, touch nothing
#    ./start.sh --detached     run in background, log to .pipeline
#    ./start.sh --stop         stop a running supervisor
#
#  Double-click support depends on the desktop environment: most file
#  managers ask whether to run or to open a text editor. Running it from
#  a terminal is the reliable way.
# =====================================================================
set -eu

# Resolve the directory of this script, following a symlink if this file
# was linked somewhere onto PATH. Without this the tool would look for
# bin/launch.mjs next to the link instead of next to itself.
script=$0
while [ -L "$script" ]; do
    target=$(readlink "$script")
    case $target in
        /*) script=$target ;;
        *) script=$(dirname -- "$script")/$target ;;
    esac
done
dir=$(CDPATH= cd -- "$(dirname -- "$script")" && pwd)

if ! command -v node >/dev/null 2>&1; then
    echo ''
    echo '  Node.js not found in PATH.'
    echo '  The supervisor is a plain Node program; nothing runs without it.'
    echo '  Version 20.12 or newer is required.'
    echo ''
    exit 1
fi

exec node "$dir/bin/launch.mjs" "$@"
