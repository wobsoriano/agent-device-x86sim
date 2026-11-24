import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import type { AxNode, Backend, HardwareButton, Size, TouchEvent } from '../types.ts';
import { buttonSteps, parseSimEnv, parseSimulatorUdid, pointSize, touchSteps } from './simhid.ts';
import type { SimhidStep } from './simhid.ts';
import { readFrontTree } from './ax-hook.ts';

export type X86SimConfig = {
  /** The x86Sim AppImage. It runs `x86sim <command>` for everything but touch and buttons. */
  appImage: string;
  /** A phone's directory, such as `var/device-a64-iphone-17-pro`. Absolute. */
  device: string;
  /** Where the accessibility hooks bind their sockets. Defaults to `/run/user/<uid>`. */
  hookSocketDir?: string;
};

const CLI_TIMEOUT_MS = 60_000;
/** A hook that does not answer in this long fails the snapshot. A phone that is still booting answers in seconds. */
const HOOK_TIMEOUT_MS = 5_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The simulator behind an x86Sim AppImage, driven by its CLI and by one simhid connection. */
export class X86SimBackend implements Backend {
  readonly #config: X86SimConfig;
  #geometry: Promise<ReturnType<typeof parseSimEnv>> | undefined;
  #socket: Promise<Socket> | undefined;
  /** Touches and buttons share one finger, so their steps never interleave. */
  #input: Promise<void> = Promise.resolve();

  constructor(config: X86SimConfig) {
    this.#config = config;
  }

  #deviceGeometry() {
    this.#geometry ??= readFile(path.join(this.#config.device, 'sim.env'), 'utf8').then(parseSimEnv);
    return this.#geometry;
  }

  #cli(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.#config.appImage,
        ['x86sim', ...args],
        { env: { ...process.env, X86SIM_DEVICE: this.#config.device }, timeout: CLI_TIMEOUT_MS },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`x86sim ${args[0]} failed: ${stderr.trim() || error.message}`));
          else resolve(stdout);
        },
      );
    });
  }

  /** The connection is opened on first use and again after it drops. */
  #connect(): Promise<Socket> {
    this.#socket ??= (async () => {
      // A long device path makes simhid.sock a symlink to a short socket path.
      const socketPath = await realpath(path.join(this.#config.device, 'data', 'simhid.sock'));
      const socket = createConnection(socketPath);
      socket.setNoDelay(true);
      // simhid sends nothing back, but an unread stream would still fill up.
      socket.on('data', () => {});
      const forget = () => {
        this.#socket = undefined;
      };
      socket.on('close', forget);
      socket.on('error', forget);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      return socket;
    })();
    this.#socket.catch(() => {
      this.#socket = undefined;
    });
    return this.#socket;
  }

  #play(steps: SimhidStep[]): Promise<void> {
    const run = this.#input.then(async () => {
      const socket = await this.#connect();
      for (const step of steps) {
        if (step.kind === 'wait') await sleep(step.ms);
        else
          await new Promise<void>((resolve, reject) =>
            socket.write(`${step.line}\n`, (error) => (error ? reject(error) : resolve())),
          );
      }
    });
    this.#input = run.catch(() => undefined);
    return run;
  }

  async screen(): Promise<Size> {
    return pointSize(await this.#deviceGeometry());
  }

  async accessibilityTree(): Promise<AxNode> {
    const udid = parseSimulatorUdid(await readFile(path.join(this.#config.device, 'sim.env'), 'utf8'));
    const dir = this.#config.hookSocketDir ?? `/run/user/${userInfo().uid}`;
    return await readFrontTree(dir, udid, HOOK_TIMEOUT_MS);
  }

  async screenshot(): Promise<Buffer> {
    const dir = await mkdtemp(path.join(tmpdir(), 'x86sim-shot-'));
    try {
      const file = path.join(dir, 'screen.png');
      await this.#cli(['screenshot', file, '1']);
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async touch(events: TouchEvent[]): Promise<void> {
    await this.#play(touchSteps(events, await this.screen()));
  }

  async typeText(text: string): Promise<void> {
    await this.#cli(['type', text]);
  }

  async pressButton(button: HardwareButton): Promise<void> {
    await this.#play(buttonSteps(button));
  }

  async installApp(appPath: string): Promise<void> {
    await this.#cli(['install', appPath]);
  }

  async launchApp(bundleId: string): Promise<void> {
    await this.#cli(['launch', bundleId]);
  }

  async terminateApp(bundleId: string): Promise<void> {
    await this.#cli(['terminate', bundleId]);
  }

  async openUrl(url: string): Promise<void> {
    await this.#cli(['openurl', url]);
  }
}
