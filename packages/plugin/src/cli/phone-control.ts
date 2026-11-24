import { spawn } from 'node:child_process';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { SPRINGBOARD_BUNDLE_ID, hookSocketNames, queryHook } from '../../../server/src/backends/ax-hook.ts';
import { defaultHookSocketDir } from '../../../server/src/backends/x86sim.ts';
import { parseSimulatorUdid } from '../../../server/src/backends/simhid.ts';
import { ACCESSIBILITY_PREFS_SCRIPT } from './accessibility-prefs.ts';
import type { Action, PhoneControl, PhoneState } from './phone.ts';

export type PhoneControlConfig = {
  appImage: string;
  /** The phone's folder. Absolute. */
  device: string;
  /** The accessibility hook to load at boot. */
  hook: string;
  /** Streams the output of x86Sim's boot script instead of keeping its tail for an error. */
  verbose: boolean;
  /** Where `verbose` output goes. */
  write: (text: string) => void;
  hookSocketDir?: string;
  /** Whether a GPU render node exists. Without one the phone draws in software. */
  hasGpu?: () => Promise<boolean>;
};

const BOOT_SCRIPT = 'cli/libexec/arm64/boot-a64.sh';
/** x86Sim's `wait home` limit in seconds. */
const HOME_TIMEOUT_S = 540;
const HOOK_WAIT_MS = 90_000;
const POLL_MS = 2_000;
const PROBE_TIMEOUT_MS = 5_000;
const OUTPUT_TAIL_LINES = 40;
const hasRenderNode = async (): Promise<boolean> =>
  (await readdir('/dev/dri').catch(() => [] as string[])).some((name) => name.startsWith('renderD'));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Finished = { code: number | null; tail: string };

/**
 * Runs a command to its exit. It waits for `exit`, not `close`, because the boot script leaves
 * the phone running and the phone's processes keep the output pipes open.
 */
function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stream: ((text: string) => void) | undefined,
): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      stream?.(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('exit', (code) => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, 200).unref();
      resolve({ code, tail: output.trimEnd().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n') });
    });
  });
}

async function runPython(args: string[]): Promise<string> {
  const finished = await run('python3', ['-I', '-c', ACCESSIBILITY_PREFS_SCRIPT, ...args], {}, undefined);
  if (finished.code !== 0)
    throw new Error(`Could not read or write the phone's accessibility preferences.\n${finished.tail}`);
  return finished.tail;
}

export function createPhoneControl(config: PhoneControlConfig): PhoneControl {
  const prefsFile = path.join(config.device, 'data', 'Library', 'Preferences', 'com.apple.Accessibility.plist');
  const stream = config.verbose ? config.write : undefined;

  const x86simEnv = { X86SIM_DEVICE: config.device };
  const bootEnv = { A64_DEVICE: config.device, X86SIM_DEVICE: config.device };

  async function script(env: NodeJS.ProcessEnv, what: string): Promise<void> {
    const finished = await run(config.appImage, ['shell', '-c', BOOT_SCRIPT], env, stream);
    if (finished.code !== 0) throw new Error(`x86Sim failed to ${what} (exit ${finished.code}).\n${finished.tail}`);
  }

  async function isRunning(): Promise<boolean> {
    try {
      const socketPath = await realpath(path.join(config.device, 'data', 'simhid.sock'));
      return await new Promise<boolean>((resolve) => {
        const socket = createConnection(socketPath);
        const done = (answer: boolean) => {
          socket.destroy();
          resolve(answer);
        };
        socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
      });
    } catch {
      return false;
    }
  }

  async function isHooked(): Promise<boolean> {
    const udid = parseSimulatorUdid(await readFile(path.join(config.device, 'sim.env'), 'utf8'));
    const dir = config.hookSocketDir ?? defaultHookSocketDir();
    const abort = new AbortController();
    try {
      const replies = hookSocketNames(await readdir(dir), udid).map((name) =>
        queryHook(path.join(dir, name), PROBE_TIMEOUT_MS, abort.signal).then(
          (reply) => reply.bundleId === SPRINGBOARD_BUNDLE_ID,
          () => false,
        ),
      );
      return (await Promise.all(replies)).some(Boolean);
    } finally {
      abort.abort();
    }
  }

  async function waitForHook(): Promise<void> {
    const deadline = Date.now() + HOOK_WAIT_MS;
    while (!(await isHooked())) {
      if (Date.now() > deadline) {
        throw new Error(
          `The phone reached the home screen, but SpringBoard's accessibility hook did not answer in ${HOOK_WAIT_MS / 1000} s. ` +
            `Check that ${config.hook} exists, then run with --verbose.`,
        );
      }
      await sleep(POLL_MS);
    }
  }

  return {
    async observe(): Promise<PhoneState> {
      const running = await isRunning();
      return {
        running,
        hooked: running && (await isHooked()),
        axPrefs: (await runPython(['check', prefsFile])) === 'true',
      };
    },
    async perform(action: Action): Promise<void> {
      switch (action) {
        case 'stop':
          return await script({ ...bootEnv, A64_STOP_ONLY: '1' }, 'stop the phone');
        case 'write-prefs':
          await runPython(['enable', prefsFile]);
          return;
        case 'boot': {
          const gpu = await (config.hasGpu ?? hasRenderNode)();
          return await script(
            { ...bootEnv, X86SIM_INSERT: config.hook, A64_KEEP: '1', ...(gpu ? {} : { X86SIM_METAL: '0' }) },
            'boot the phone',
          );
        }
        case 'wait-home': {
          const finished = await run(
            config.appImage,
            ['x86sim', 'wait', 'home', String(HOME_TIMEOUT_S)],
            x86simEnv,
            stream,
          );
          if (finished.code !== 0)
            throw new Error(`The phone did not reach the home screen in ${HOME_TIMEOUT_S} s.\n${finished.tail}`);
          return;
        }
        case 'wait-hook':
          return await waitForHook();
      }
    },
  };
}
