# agent-device-x86sim

An [agent-device](https://github.com/callstack/agent-device) plugin that drives an iOS simulator on Linux through [x86Sim](https://github.com/x86sim/x86sim). You keep the usual agent-device commands: `open`, `snapshot -i`, `press @e3`, and `screenshot`. You do not need a Mac. In this README, "the phone" is the simulated iPhone that x86Sim runs.

The plugin is not on npm yet. Until it is, install it from a local registry as described in [CONTRIBUTING.md](CONTRIBUTING.md).

## How it fits together

```
agent-device + plugin  ──HTTP──▶  x86sim-webdriver  ──▶  x86Sim  ──▶  the phone
(any machine)                     (Linux machine)        (Linux machine)
```

- The plugin tells agent-device where the server is.
- The server, `x86sim-webdriver`, runs next to x86Sim. It turns agent-device's WebDriver requests into x86Sim input and screenshots.
- The accessibility hook, `libx86sim-ax.dylib`, runs inside the phone. It gives the server the list of elements on the screen. `snapshot -i` prints that list.

## Requirements

- A Linux machine that meets [x86Sim's requirements](https://github.com/x86sim/x86sim#requirements): x86-64, glibc 2.39 or newer, at least 8 GB of memory, and 45 GB of free disk. Ubuntu 24.04 or newer has the right glibc. x86Sim recommends 16 GB of memory. A GPU is optional. Without one, the phone draws in software and is slower.
- Node.js 22.18 or newer on the Linux machine.
- agent-device 0.21.35 or newer, on the Linux machine or on another machine.

The examples use these paths. Change them to match your machine.

```sh
export X86SIM=~/x86sim/x86sim-0.5.3-x86_64.AppImage
export X86SIM_DEVICE=~/.local/share/x86sim/var/device-a64-iphone-17-pro
```

## Set up the Linux machine

1. Install x86Sim and download iOS.

   Download the AppImage from the [latest x86Sim release](https://github.com/x86sim/x86sim/releases/latest) and make it executable. Then run:

   ```sh
   $X86SIM aot setup check
   $X86SIM x86sim runtime fetch 24B8117                   # iOS 27.2, about 8 GB from Apple
   $X86SIM x86sim device create --model "iPhone 17 Pro"
   ```

   Check: `$X86SIM x86sim device list` shows `device-a64-iphone-17-pro`.

2. Copy this repository to the Linux machine, and enter its folder.

   The repository includes the accessibility hook, prebuilt for the iOS simulator. Save its path for step 4.

   ```sh
   export AX_HOOK=$PWD/packages/ax-hook/prebuilt/libx86sim-ax.dylib
   ```

3. Turn on accessibility inside the phone.

   UIKit describes its controls only when accessibility is on. Do this once, while the phone is stopped.

   ```sh
   python3 - <<'PY'
   import os, plistlib
   p = os.path.expanduser("~/.local/share/x86sim/var/device-a64-iphone-17-pro/data/Library/Preferences/com.apple.Accessibility.plist")
   d = plistlib.load(open(p, "rb")) if os.path.exists(p) else {}
   d.update(ApplicationAccessibilityEnabled=True, AccessibilityEnabled=True)
   plistlib.dump(d, open(p, "wb"), fmt=plistlib.FMT_BINARY)
   PY
   ```

4. Boot the phone with the hook loaded.

   ```sh
   cd ~/x86sim
   X86SIM_INSERT=$AX_HOOK A64_DEVICE=var/device-a64-iphone-17-pro A64_KEEP=1 \
     $X86SIM shell -c cli/libexec/arm64/boot-a64.sh
   $X86SIM x86sim wait home 540
   ```

   On a machine without a GPU, add `X86SIM_METAL=0` before `X86SIM_INSERT`.

   Check: `wait home` exits with code 0. A boot takes 1.5 to 6 minutes.

5. Start the server from the repository folder.

   ```sh
   node packages/server/src/main.ts --backend x86sim --appimage $X86SIM --device $X86SIM_DEVICE --port 4723
   ```

   Check: `curl -s localhost:4723/status` prints `{"value":{"ready":true,...}}`.

## Connect agent-device

1. Install the plugin.

   ```sh
   agent-device plugins add agent-device-x86sim
   ```

   If an agent-device daemon is running, stop it so that it loads the plugin.

2. If agent-device runs on a different machine, forward the server port to it.

   ```sh
   ssh -N -L 4723:localhost:4723 linux-box &
   ```

   The plugin uses `http://127.0.0.1:4723`. To use another address, set `X86SIM_WEBDRIVER_ENDPOINT`.

3. Connect.

   ```sh
   agent-device connect x86sim
   ```

   Check: the output says `Connected successfully with x86Sim.` and `x86Sim WebDriver server is ready`.

## Use it

```sh
agent-device open com.apple.Preferences
agent-device snapshot -i
agent-device press @e2
agent-device screenshot ./screen.png
agent-device home
agent-device close
agent-device disconnect
```

A `snapshot -i` in Settings looks like this:

```
@e1 [application] "Preferences"
@e2 [button] "General"
@e3 [button] "Accessibility"
@e4 [button] "Action Button"
```

To test your own app, install an arm64 iOS simulator build on the Linux machine, then open it by its bundle id.

```sh
# on the Linux machine
X86SIM_DEVICE=$X86SIM_DEVICE $X86SIM x86sim install ./MyApp.app
# where agent-device runs
agent-device open com.example.myapp
```

`agent-device install` sends a file path from the machine that runs agent-device. The server looks for that path on the Linux machine. So `install` works only when agent-device runs on the Linux machine.

## Notes for agents

- Take a new `snapshot -i` after every `press`. Refs such as `@e3` change from one snapshot to the next.
- The phone shows the result of an input 1 to 15 seconds later, depending on the machine. If the element you expect is missing, wait 2 seconds and take another snapshot. Do not press again.
- Right after a page opens, the snapshot can still list the previous page. Poll until the element you want appears.
- `open` takes a bundle id, for example `com.apple.Preferences`. It does not take an app name.
- These operations return `UNSUPPORTED_OPERATION`: `fill`, `back`, `orientation`, the keyboard state, and the clipboard. To enter text, press the field, then use `type`.

## Troubleshooting

| Symptom                                                    | Cause                                                   | Fix                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `connect x86sim` says the server is not reachable          | The server is not running, or the port is not forwarded | Start the server (Linux step 5). Check `curl localhost:4723/status` on the machine that runs agent-device. |
| `snapshot -i` lists only `[application]`                   | The hook is not loaded, or accessibility is off         | Repeat Linux steps 3 and 4. Stop the phone first with `A64_STOP_ONLY=1` in place of `A64_KEEP=1`.          |
| `--provider-app is not supported by x86Sim`                | An old plugin sends the bundle id as `--provider-app`   | Update the plugin with `agent-device plugins update agent-device-x86sim`, then stop the daemon.            |
| A screenshot shows the screen from before the last `press` | The phone has not drawn the new frame yet               | Wait 2 seconds and take the screenshot again.                                                              |
| `connect x86sim` is not a known provider                   | The daemon started before you installed the plugin      | Stop the agent-device daemon and run the command again.                                                    |

## Limits

- Apps must be arm64 iOS simulator builds. App Store builds and device builds do not run.
- x86Sim has its own gaps: no Maps tiles, no Bonjour, no sensors, and no app sandbox. See [x86Sim's status and limitations](https://github.com/x86sim/x86sim#status-and-limitations).
- `snapshot -i` reads the app in front. System alerts over an app and web content inside an app are not listed yet.
- Typing into text fields is not tested yet.
- x86Sim downloads Apple's iOS simulator runtime to your machine. Apple's license for that runtime covers Apple hardware.
