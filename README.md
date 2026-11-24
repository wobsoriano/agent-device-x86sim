# agent-device-x86sim

Let [agent-device](https://github.com/callstack/agent-device) drive an iOS simulator running under x86Sim, through agent-device's built-in WebDriver engine.

Milestone 1 proves the plumbing against a fake simulator backend. Milestone 2 adds the real x86Sim backend and a live run against an iPhone 17 Pro on a Linux VM. The accessibility tree is not hooked up yet, so a snapshot holds only the root application node.

- `packages/server` is `x86sim-webdriver`, a small WebDriver server. It owns the protocol. A `Backend` owns the simulator, and input reaches it as a stream of `down`, `move`, `up` and `pause` touch events.
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

`scripts/e2e-live.ts` opens Settings, taps the General row by coordinate, presses home, and saves a screenshot after each step. x86Sim shows an input's result seconds later, so the script waits for the pixels to change before it saves a picture.
