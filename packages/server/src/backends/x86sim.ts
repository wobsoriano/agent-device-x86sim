import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AxNode, Backend, HardwareButton, Size, TouchEvent } from '../types.ts';
import { buttonSteps, parseSimEnv, pointSize, touchSteps } from './simhid.ts';
import type { SimhidStep } from './simhid.ts';

export type X86SimConfig = {
  /** The x86Sim AppImage. It runs `x86sim <command>` for everything but touch and buttons. */
  appImage: string;
  /** A phone's directory, such as `var/device-a64-iphone-17-pro`. Absolute. */
  device: string;
};

const CLI_TIMEOUT_MS = 60_000;
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
      const forget = () => void (this.#socket = undefined);
      socket.on('close', forget);
      socket.on('error', forget);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      return socket;
    })();
    this.#socket.catch(() => void (this.#socket = undefined));
    return this.#socket;
  }

  #play(steps: SimhidStep[]): Promise<void> {
    const run = this.#input.then(async () => {
      const socket = await this.#connect();
      for (const step of steps) {
        if (step.kind === 'wait') await sleep(step.ms);
        else await new Promise<void>((resolve, reject) => socket.write(`${step.line}\n`, (error) => (error ? reject(error) : resolve())));
      }
    });
    this.#input = run.catch(() => undefined);
    return run;
  }

  async screen(): Promise<Size> {
    return pointSize(await this.#deviceGeometry());
  }

  async accessibilityTree(): Promise<AxNode> {
    // The AX hook is the next milestone, so for now the tree is the application and nothing in it.
    return {
      type: 'XCUIElementTypeApplication',
      frame: { x: 0, y: 0, ...(await this.screen()) },
      enabled: true,
      visible: true,
      children: [],
    };
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
