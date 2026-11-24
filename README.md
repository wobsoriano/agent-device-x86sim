# agent-device-x86sim

Let [agent-device](https://github.com/callstack/agent-device) drive an iOS simulator running under x86Sim, through agent-device's built-in WebDriver engine.

Milestone 1 proves the plumbing against a fake simulator backend. There is no x86Sim backend yet.

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
