#!/usr/bin/env bash
# Builds Hello.app, an arm64 iOS simulator app, without an Xcode project.
# Needs a Mac with Xcode. Output: examples/hello-app/build/Hello.app and Hello.app.zip
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
export SDKROOT="$SDK"
APP=build/Hello.app
rm -rf build
mkdir -p "$APP"

xcrun --sdk iphonesimulator swiftc -parse-as-library -O \
	-sdk "$SDK" -target arm64-apple-ios17.0-simulator \
	-o "$APP/Hello" HelloApp.swift
cp Info.plist "$APP/Info.plist"
codesign --force --sign - --timestamp=none "$APP"

# ditto keeps permissions and the code signature intact inside the zip
ditto -c -k --keepParent "$APP" build/Hello.app.zip
vtool -show-build "$APP/Hello" | grep -E "platform|minos"
echo "built $APP and build/Hello.app.zip"
