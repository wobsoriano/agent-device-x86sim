#!/usr/bin/env bash
# Builds libx86sim-ax.dylib, a genuine arm64 iOS-simulator library, ad-hoc signed. Needs a Mac with Xcode.
#   packages/ax-hook/build.sh   ->   packages/ax-hook/build/libx86sim-ax.dylib
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[ "$(uname -s)" = Darwin ] || { echo "build.sh needs macOS with Xcode" >&2; exit 1; }
SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
mkdir -p build
xcrun --sdk iphonesimulator clang -arch arm64 -target arm64-apple-ios17.0-simulator -isysroot "$SDK" \
	-dynamiclib -O2 -Wall -Wextra -Wno-unused-parameter \
	-install_name @rpath/libx86sim-ax.dylib -Wl,-dead_strip_dylibs -lobjc -o build/libx86sim-ax.dylib ax.c
codesign -f -s - build/libx86sim-ax.dylib
echo "built $PWD/build/libx86sim-ax.dylib"
