# agent-device-x86sim

An [agent-device](https://github.com/callstack/agent-device) plugin that drives an iOS simulator on Linux through [x86Sim](https://github.com/x86sim/x86sim). In this README, "the phone" is the simulated iPhone that x86Sim runs.

The package is not on npm yet. Until it is, install it from a local registry as described in [CONTRIBUTING.md](CONTRIBUTING.md).

## How it fits together

```
agent-device + plugin  ──HTTP──▶  server  ──▶  x86Sim  ──▶  the phone
```

- agent-device sends its commands to a WebDriver server. The plugin tells agent-device where that server is.
- The server runs on the Linux machine next to x86Sim. It turns WebDriver requests into x86Sim input and screenshots.
- The accessibility hook, `libx86sim-ax.dylib`, runs inside the phone. It gives the server the list of elements on the screen. `snapshot -i` prints that list.
- The package `agent-device-x86sim` has the plugin, the server, the hook, and the `agent-device-x86sim` command.

When agent-device runs on the Linux machine, the plugin starts the server and boots the phone for you. When agent-device runs on another machine, you start the server yourself with one command.

## Requirements

- A Linux machine that meets [x86Sim's requirements](https://github.com/x86sim/x86sim#requirements). It needs x86-64, glibc 2.39 or newer, at least 8 GB of memory, and 45 GB of free disk. Ubuntu 24.04 or newer has the right glibc. x86Sim recommends 16 GB of memory. A GPU is optional. Without one, the phone draws in software and is slower.
- Node.js 22.18 or newer and Python 3 on the Linux machine.
- agent-device 0.21.35 or newer, on the Linux machine or on another machine.

## Use agent-device on the Linux machine

1. Set up x86Sim with its [Quick start](https://github.com/x86sim/x86sim#quick-start).

   Download the AppImage anywhere and run it. The Setup page of the launcher downloads iOS and creates your first phone. You do not boot the phone, load the hook, or turn on accessibility. The plugin does that for you.

   Check: the launcher lists a phone.

2. Install the plugin.

   ```sh
   agent-device plugins add agent-device-x86sim
   ```

   If an agent-device daemon is running, stop it so that it loads the plugin.

3. Connect.

   ```sh
   agent-device connect x86sim
   ```

   Check: the output says `Connected successfully with x86Sim.` and names your phone.

4. Open an app.

   ```sh
   agent-device open com.apple.Preferences
   ```

   The first `open` boots the phone with the hook. That takes up to 6 minutes. Later opens take a few seconds.

   Check: the output says `Opened: com.apple.Preferences`.

5. Read the screen and press a row.

   ```sh
   agent-device snapshot -i
   agent-device press @e8
   agent-device snapshot -i
   agent-device screenshot ./screen.png
   ```

   A `snapshot -i` in Settings looks like this:

   ```
   @e1 [application] "Settings"
   @e2 [navigation-bar] "Settings"
   @e3 [text] "Settings"
   @e4 [collection] "com.apple.settings.sidebar.collectionView"
     [content below collection hidden]
   @e5 [cell] "Apple Account"
   @e6 [button] "Apple Account, Sign in to access your iCloud data, the App Store, Apple services, and more."
   @e7 [cell] "General"
   @e8 [cell] "Accessibility"
   ...
   @e17 [search] "Search" [editable]
   @e20 [toolbar] "Toolbar"
   ```

   The element types and containers are the ones XCTest reports on a Mac, because the hook reads the tree that UIKit builds for XCTest.

   Check: the second `snapshot -i` lists the rows of the page you pressed.

Close the session when you are done.

```sh
agent-device home
agent-device close
agent-device disconnect
```

The plugin finds x86Sim in its data folder, `~/.local/share/x86sim`, wherever you saved the AppImage. If you have several phones, it uses the one that runs. When none runs, choose one by the name the launcher shows.

```sh
agent-device connect x86sim --device "iPhone 17 Pro"
```

The plugin starts its server only on Linux and only when no server address is set.

If the phone was started by the launcher, or runs an older accessibility hook, the plugin restarts it once to load the current hook and turn on accessibility.

## Run agent-device on another machine

agent-device sends its commands to a WebDriver server that runs next to the simulator. Device clouds such as BrowserStack run that server for you. x86Sim runs on your machine, so on another machine you start the server yourself.

1. On the Linux machine, start the server.

   ```sh
   npx agent-device-x86sim serve
   ```

   The command boots the phone if it needs a boot. It prints progress lines to stderr, and a `Ready` line when the server accepts commands. When the phone already runs with the hook, `serve` reaches `Ready` in seconds. Leave it running.

   Check: the last lines start with `Ready.` and name the commands to run next.

2. On the machine that runs agent-device, forward the port.

   ```sh
   ssh -N -L 4723:localhost:4723 linux-box &
   ```

   The plugin uses `http://127.0.0.1:4723`. To use another address, set `X86SIM_WEBDRIVER_ENDPOINT`.

3. Install the plugin and connect.

   ```sh
   agent-device plugins add agent-device-x86sim
   agent-device connect x86sim
   ```

   Check: the output says `Connected successfully with x86Sim.` and `x86Sim WebDriver server is ready`.

4. Use agent-device as in the section above, from `open` on.

`serve` takes these options.

| Option               | Meaning                                                                           |
| -------------------- | --------------------------------------------------------------------------------- |
| `--appimage PATH`    | Use this AppImage instead of the copy in the data folder. Else `X86SIM_APPIMAGE`. |
| `--device NAME\|DIR` | The phone, by name or folder name. Else the running phone, else the only phone.   |
| `--port PORT`        | Default 4723.                                                                     |
| `--host HOST`        | Default 127.0.0.1.                                                                |
| `--verbose`          | Log every request and the output of x86Sim's boot script.                         |

`npx agent-device-x86sim hook-path` prints the path of the accessibility hook that the package ships.

## Test your own app

Install an arm64 iOS simulator build on the Linux machine, then open it by its bundle id.

```sh
# on the Linux machine, in the folder of the AppImage
./x86sim-0.5.3-x86_64.AppImage x86sim install ./MyApp.app
# where agent-device runs
agent-device open com.example.myapp
```

`agent-device install` sends a file path from the machine that runs agent-device. The server looks for that path on the Linux machine. So `install` works only when agent-device runs on the Linux machine.

## Notes for agents

- Take a new `snapshot -i` after every `press`. Refs such as `@e3` change from one snapshot to the next.
- The phone shows the result of an input 1 to 15 seconds later, depending on the machine. If the element you expect is missing, wait 2 seconds and take another snapshot. Do not press again.
- Right after a page opens, the snapshot can still list the previous page. Poll until the element you want appears.
- `open` takes a bundle id, for example `com.apple.Preferences`. It does not take an app name.
- The first `open` on the Linux machine boots the phone and can take up to 6 minutes. Do not run it again while it runs.
- These operations return `UNSUPPORTED_OPERATION`: `fill`, `back`, `orientation`, the keyboard state, and the clipboard. To enter text, press the field, then use `type`.

## Troubleshooting

| Symptom                                                                          | Cause                                                                                | Fix                                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `connect x86sim` says the server is not reachable                                | agent-device runs on another machine, and the server is not running or not forwarded | Run `npx agent-device-x86sim serve` on the Linux machine. Check `curl localhost:4723/status` where agent-device runs. |
| The plugin or `serve` says x86Sim is not set up                                  | The AppImage never ran on this machine, or it ran with another `X86SIM_DATA`         | Follow the [Quick start](https://github.com/x86sim/x86sim#quick-start). Use the same `X86SIM_DATA` for the plugin.    |
| The plugin or `serve` says to pick a phone                                       | There is more than one phone and none runs                                           | Run `agent-device connect x86sim --device "<name>"`, or `serve --device "<name>"`.                                    |
| `serve` says the port is in use                                                  | Another server runs on that port                                                     | Stop it, or pass `--port`.                                                                                            |
| The plugin does not start the server on the Linux machine                        | `X86SIM_WEBDRIVER_ENDPOINT` is set                                                   | Unset the variable.                                                                                                   |
| `snapshot -i` lists only `[application]`, or says `UIKit's accessibility is off` | The hook is not loaded, or accessibility is off                                      | Run `npx agent-device-x86sim serve` again. It stops a phone that lacks the hook and boots it again.                   |
| `--provider-app is not supported by x86Sim`                                      | An old plugin sends the bundle id as `--provider-app`                                | Update the plugin with `agent-device plugins update agent-device-x86sim`, then stop the daemon.                       |
| A screenshot shows the screen from before the last `press`                       | The phone has not drawn the new frame yet                                            | Wait 2 seconds and take the screenshot again.                                                                         |
| `connect x86sim` is not a known provider                                         | The daemon started before you installed the plugin                                   | Stop the agent-device daemon and run the command again.                                                               |

## Limits

- Apps must be arm64 iOS simulator builds. App Store builds and device builds do not run.
- x86Sim has its own gaps, such as no Maps tiles, no Bonjour, no sensors, and no app sandbox. See [x86Sim's status and limitations](https://github.com/x86sim/x86sim#status-and-limitations).
- `snapshot -i` reads the app in front. System alerts over an app and web content inside an app are not listed yet.
- Typing into text fields is not tested yet.
- x86Sim downloads Apple's iOS simulator runtime to your machine. Apple's license for that runtime covers Apple hardware.
