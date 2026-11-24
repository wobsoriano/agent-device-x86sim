# Contributing

This repository is a [Vite+](https://viteplus.dev) monorepo on pnpm workspaces. Install the `vp` CLI, then run every command through it.

## Layout

- `packages/plugin` is the npm package `agent-device-x86sim`, the only package that is published. It is an agent-device provider plugin (`apiVersion` 2) and the `agent-device-x86sim` command. `vp pack` builds it to `packages/plugin/dist` and copies the prebuilt hook to `packages/plugin/ax-hook`. `src/cli/` holds the command: argument parsing, discovery of the AppImage and the phone, the phone preparation table, and the server start-up that `serve` and the plugin share. `src/auto-start.ts` starts that server inside the agent-device daemon.
- `packages/server` is `x86sim-webdriver`. It stays private and the plugin bundles it. It also runs from source with Node type stripping, for development. A `Backend` owns the simulator: `backends/fake.ts` for tests and `backends/x86sim.ts` for a real phone.
- `packages/ax-hook` is the C accessibility hook. `build.sh` builds it on a Mac with Xcode. It is not a pnpm workspace package.
- `scripts/e2e.ts` runs agent-device in-process against the fake backend. `scripts/e2e-live.ts` runs it against a real phone.

## Checks

```sh
vp install
vp check            # format, lint, and type checks
vp run -r test      # unit tests
vp run -r build     # builds the plugin
vp run e2e          # builds the plugin, then runs scripts/e2e.ts against the fake backend
vp run ready        # check, test, and build in one command
```

`e2e` is a task in `vite.config.ts` with the cache off. Run it with `vp run e2e`, not `pnpm e2e`.

## Run the server against the fake backend

```sh
node packages/server/src/main.ts --backend fake --port 4723
```

The server logs one line per request to stderr. The fake backend records input at `GET /__fake/log`.

## Live run against a real phone

Set up the Linux machine as the README describes. Then start the server from the built package on the Linux machine, or let the plugin start it.

```sh
vp run agent-device-x86sim#build
node packages/plugin/dist/cli.js serve
```

On the machine that runs agent-device:

```sh
ssh -N -L 4723:localhost:4723 linux-box &
node scripts/e2e-live.ts ./live-out
```

The script opens Settings, presses Home, presses the Settings icon and the General row by `@eN` ref, and saves screenshots to `./live-out`. It waits for elements and for changed pixels, because x86Sim draws the result of an input seconds later.

## Rebuild the accessibility hook

Users run the prebuilt hook in `packages/ax-hook/prebuilt/libx86sim-ax.dylib`. If you change `packages/ax-hook/ax.c`, rebuild it on a Mac with Xcode and commit the new prebuilt file with the source change.

```sh
packages/ax-hook/build.sh
cp packages/ax-hook/build/libx86sim-ax.dylib packages/ax-hook/prebuilt/
vtool -show-build packages/ax-hook/prebuilt/libx86sim-ax.dylib   # platform IOSSIMULATOR
```

## Hook protocol

Every phone process that starts UIKit listens on `/run/user/<uid>/x86sim-ax-<SIMULATOR_UDID>-<pid>.sock`. A client sends `tree\n` and reads one JSON line, `{ pid, bundleId, root }`. The `root` field is an `AxNode` from `packages/server/src/types.ts`. The SpringBoard answer also has `front`, the app in front, or `null` on the home screen. `tree debug\n` adds the class and traits of each element.

The server asks SpringBoard first, then only the app in front. A suspended app accepts the connection and never answers.

## Install the package through the real CLI before publishing

`agent-device plugins add` and `npx` install only from an npm registry. To test those paths, publish to a local [Verdaccio](https://verdaccio.org) registry. Never publish a local build to the public registry.

1. Start Verdaccio with a config that allows anonymous publishing of `agent-device-x86sim` and proxies everything else to npmjs. It listens on `127.0.0.1:4873`.
2. Build the package with `vp run agent-device-x86sim#build`. The tarball must hold `dist` and `ax-hook`. Check it with `npm pack --dry-run` in `packages/plugin`.
3. Give the build a local version, publish it, and restore `package.json`.

   ```sh
   cd packages/plugin
   npm pkg set version=0.1.0-local.1
   npm publish --registry http://127.0.0.1:4873 --//127.0.0.1:4873/:_authToken=anon --tag local
   git checkout package.json
   ```

4. Install the plugin into agent-device.

   ```sh
   npm_config_registry=http://127.0.0.1:4873 agent-device plugins add agent-device-x86sim@0.1.0-local.1
   ```

5. Stop the agent-device daemon so that it loads the new plugin. Then run `agent-device connect x86sim`.
6. To test `serve` on a Linux machine, expose the registry there with `boat forward <sandbox> --reverse --local 4873` or an SSH reverse tunnel, then run `npx --registry http://127.0.0.1:4873 agent-device-x86sim@0.1.0-local.1 serve`.
