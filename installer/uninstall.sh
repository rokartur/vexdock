#!/bin/sh
# Convenience wrapper: `curl … | sudo sh -s uninstall` on the main installer.
set -eu
exec "$(dirname "$0")/install.sh" uninstall "$@"
