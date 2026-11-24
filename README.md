# agent-device-x86sim

Let [agent-device](https://github.com/callstack/agent-device) drive an iOS simulator running under x86Sim, through agent-device's built-in WebDriver engine.

Milestone 1 proves the plumbing against a fake simulator backend. Milestone 2 adds the real x86Sim backend and a live run against an iPhone 17 Pro on a Linux VM. Milestone 3 reads the accessibility tree inside the phone, so `snapshot -i` lists real elements and `@eN` refs press them.

- `packages/server` is `x86sim-webdriver`, a small WebDriver server. It owns the protocol. A `Backend` owns the simulator, and input reaches it as a stream of `down`, `move`, `up` and `pause` touch events.
- `packages/ax-hook` is `libx86sim-ax.dylib`, a small iOS-simulator library that runs inside the phone and answers accessibility queries on a Unix socket.
- `packages/plugin` is `agent-device-x86sim`, an agent-device provider plugin (`apiVersion` 2) that points the WebDriver engine at that server.

```sh
npm install
npm test                 # node --test, unit tests and an HTTP round trip
npm run typecheck
npm run e2e              # builds the plugin, then runs scripts/e2e.ts
node packages/server/src/main.ts --backend fake --port 4723
```

`scripts/e2e.ts` starts the fake server, starts agent-device in this process with the plugin, opens a session, takes an interactive snapshot, presses "Continue", and checks the fake backend's `GET /__fake/log` for a touch inside the button. The server logs one line per request to stderr.

## Live run against x86Sim

The x86sim backend runs on the Linux host that runs the phone. Touch and hardware buttons go to the phone's simhid socket over one persistent connection, and everything else goes through `x86sim <command>` in the AppImage.

```sh
# on the VM
node packages/server/src/main.ts --backend x86sim --appimage ~/x86sim/x86sim-0.5.3-x86_64.AppImage \
  --device ~/.local/share/x86sim/var/device-a64-iphone-17-pro --port 4723
# on the Mac
boat forward <sandbox> --remote 4723 --local 4723 &
npm run build && node scripts/e2e-live.ts [outDir]   # screenshots land in live-out/ by default
```

### The accessibility hook

The hook is loaded into every phone process at boot. It needs three things, none of which a running phone has by default.

```sh
# on the Mac
packages/ax-hook/build.sh                      # packages/ax-hook/build/libx86sim-ax.dylib, arm64 iOS simulator, ad-hoc signed
boat scp packages/ax-hook/build/libx86sim-ax.dylib <sandbox>:/home/user/ax-hook/libx86sim-ax.dylib
# on the VM, with the phone stopped (A64_STOP_ONLY=1 ... boot-a64.sh): turn on app accessibility
python3 - <<'PY'
import plistlib
p = "/home/user/.local/share/x86sim/var/device-a64-iphone-17-pro/data/Library/Preferences/com.apple.Accessibility.plist"
d = plistlib.load(open(p, "rb"))
d.update(ApplicationAccessibilityEnabled=True, AccessibilityEnabled=True)
plistlib.dump(d, open(p, "wb"), fmt=plistlib.FMT_BINARY)
PY
# boot with the hook (x86Sim adds X86SIM_INSERT to DYLD_INSERT_LIBRARIES of every phone process)
X86SIM_INSERT=/home/user/ax-hook/libx86sim-ax.dylib A64_DEVICE=var/device-a64-iphone-17-pro A64_KEEP=1 X86SIM_METAL=0 \
  ./x86sim-0.5.3-x86_64.AppImage shell -c cli/libexec/arm64/boot-a64.sh
```

Every process that starts UIKit binds `/run/user/<uid>/x86sim-ax-<SIMULATOR_UDID>-<pid>.sock`. A client sends `tree\n` and reads one JSON line, `{ pid, bundleId, root }`, where `root` is an `AxNode`. SpringBoard's answer also holds `front`, the app in front or `null` on the home screen. `tree debug\n` adds each element's class and traits. The server asks SpringBoard first and then only the front app, because a suspended app accepts the connection and never answers.

```sh
python3 - <<'PY'   # a direct query on the VM
import socket; s = socket.socket(socket.AF_UNIX); s.connect("/run/user/1000/x86sim-ax-<udid>-<pid>.sock")
s.sendall(b"tree debug\n"); print(s.makefile().readline())
PY
```

`scripts/e2e-live.ts` goes through agent-device. It opens Settings, presses Home, lists the home screen with `snapshot -i`, presses the Settings icon by its `@eN` ref, lists Settings, presses the General row by ref, and saves a screenshot of the General page. x86Sim shows an input's result seconds later, so the script waits for the elements, and for the pixels to change, before it moves on.
