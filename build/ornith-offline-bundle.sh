#!/usr/bin/env bash
# Staples the llama-server binary + Ornith .gguf model into an already-packaged build,
# producing the "offline installer" variant (~10GB). The app's LlamaManagerChannel looks in
# <resources>/ornith first, so a bundled install needs zero downloads and zero clicks.
#
# Usage:
#   build/ornith-offline-bundle.sh <packaged-app-dir> <llama-server-binary> <model.gguf>
#
#   <packaged-app-dir>  e.g. ../VSCode-linux-x64            (linux/windows package root)
#                       e.g. ../VSCode-darwin-arm64/Void.app (macOS bundle)
#
# The default (recommended) distribution is the SMALL installer without this step:
# users run "Void: Set Up Local Ornith Model" which downloads the model (resumable) on first use.
set -euo pipefail

PKG_DIR="${1:?packaged app dir required}"
BIN="${2:?llama-server binary required}"
MODEL="${3:?model .gguf required}"

if [ -d "$PKG_DIR/Contents/Resources" ]; then
	DEST="$PKG_DIR/Contents/Resources/ornith"   # macOS .app
elif [ -d "$PKG_DIR/resources" ]; then
	DEST="$PKG_DIR/resources/ornith"            # linux / windows
else
	echo "ERROR: $PKG_DIR does not look like a packaged app (no resources dir)" >&2
	exit 1
fi

case "$MODEL" in *.gguf) ;; *) echo "ERROR: model must be a .gguf file" >&2; exit 1;; esac

mkdir -p "$DEST"
cp -v "$BIN" "$DEST/$(basename "$BIN")"
chmod +x "$DEST/$(basename "$BIN")"
cp -v "$MODEL" "$DEST/$(basename "$MODEL")"

echo "Bundled into $DEST:"
du -sh "$DEST"
