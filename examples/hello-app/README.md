# Hello, a test app

A one-screen SwiftUI app to drive with agent-device. Type a name, press **Say hello**, and the app shows "Hello, <name>!". It uses a dark theme.

The prebuilt app is attached to the [hello-app-v1 release](https://github.com/wobsoriano/agent-device-x86sim/releases/tag/hello-app-v1) as `Hello.app.zip`. It is an arm64 iOS simulator build with the bundle id `com.wobsoriano.x86sim.hello`.

## Install and drive it

Run these on the Linux machine, inside WSL on Windows. Keep the files in the Linux file system (`~`), not under `/mnt/c`, so the app keeps its permissions and signature.

```sh
cd ~
gh release download hello-app-v1 --repo wobsoriano/agent-device-x86sim --pattern Hello.app.zip
unzip -o -q Hello.app.zip
~/x86sim/x86sim-*.AppImage x86sim install ./Hello.app

agent-device open com.wobsoriano.x86sim.hello
agent-device snapshot -i
```

`snapshot -i` lists the name field and the button:

```
@e5 [text-field] "Jane Appleseed" [editable]
@e6 [button] "Say hello" [disabled]
```

Press the field, type a name, then press the button. Take a new snapshot before each press, because refs change.

```sh
agent-device press @e5
agent-device type "Rob"
agent-device snapshot -i
agent-device press @e6
agent-device snapshot -i
```

Check: the last snapshot lists `[text] "Hello, Rob!"`.

The field, the button and the greeting have the accessibility identifiers `nameField`, `greetButton` and `greetingLabel`.

## Build it

The build needs a Mac with Xcode. It uses no Xcode project.

```sh
examples/hello-app/build.sh
```

The script writes `examples/hello-app/build/Hello.app` and `Hello.app.zip`, and prints `platform IOSSIMULATOR`.
