#!/usr/bin/env bash
#
# Install the Opencode /goal plugin into an opencode PROJECT or GLOBAL config dir.
#
# Why a package DIR + one-line entry (not a single file)?
#   The plugin imports `@opencode-ai/plugin` at runtime (tool() in tools.ts).
#   opencode only resolves that dependency for plugin files living UNDER the
#   opencode plugin directory (it installs the runtime deps into
#   <root>/.opencode/node_modules). A file that re-exports from a path OUTSIDE
#   that tree fails to resolve and the plugin is silently skipped. So we ship all
#   of src/* as a subdir `plugin/goalpkg/` plus a tiny `plugin/goal.ts` entry that
#   re-exports from it. See docs/superpowers/verification/2026-07-05-task7-live-proof.md.
#
# Usage:
#   scripts/install.sh <project-dir>           # -> <project-dir>/.opencode/plugin/...
#   scripts/install.sh ~/.config/opencode      # global -> ~/.config/opencode/plugin/...
#
# src/ stays the single source of truth; this script only copies it into place.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: install.sh <opencode-config-or-project-dir>" >&2
  echo "  e.g. install.sh ~/.config/opencode   (global)" >&2
  echo "       install.sh /path/to/project     (project)" >&2
  exit 2
fi

# Normalize the target to an absolute path (creating it if needed).
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"

# Resolve the opencode root that holds plugin/ and command/.
#   Global config dir (basename 'opencode', e.g. ~/.config/opencode): use directly.
#   Otherwise treat as a project dir and nest under .opencode/.
if [ "$(basename "$TARGET")" = "opencode" ]; then
  OC_DIR="$TARGET"
else
  OC_DIR="$TARGET/.opencode"
fi

PKG_DIR="$OC_DIR/plugin/goalpkg"
CMD_DIR="$OC_DIR/command"

mkdir -p "$PKG_DIR" "$CMD_DIR"

# Package body: all of src/* (TypeScript modules + the verbatim continuation template).
cp "$REPO_ROOT"/src/*.ts "$PKG_DIR"/
cp "$REPO_ROOT"/src/continuation.template.md "$PKG_DIR"/

# One-line entry opencode loads; it re-exports the plugin from the co-located package.
printf 'export { GoalPlugin } from "./goalpkg/plugin.ts"\n' > "$OC_DIR/plugin/goal.ts"

# The /goal command surface.
cp "$REPO_ROOT/.opencode/command/goal.md" "$CMD_DIR/goal.md"

echo "Installed /goal plugin:"
echo "  entry:   $OC_DIR/plugin/goal.ts"
echo "  package: $PKG_DIR/"
echo "  command: $CMD_DIR/goal.md"
