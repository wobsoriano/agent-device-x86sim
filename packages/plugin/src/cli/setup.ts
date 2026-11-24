import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { X86SIM_VERSION } from './args.ts';
import type { SetupOptions } from './args.ts';
import type { Environment } from './discovery.ts';
import { NotSetUpError, findPhone, findX86Sim, listPhones } from './discovery.ts';
import type { Launch, X86Sim } from './install.ts';
import { x86simDataDir } from './install.ts';
import { systemEnvironment } from './system.ts';

/** iOS 27.2, the runtime x86Sim creates phones on by default. */
const RUNTIME_BUILD = '24B8117';
const RUNTIME_DIR = 'ios-27.2-24B8117-arm64';
/** Apple's download stops now and then, and x86Sim's fetch resumes where it stopped. */
const FETCH_ATTEMPTS = 5;

/**
 * One part of a working x86Sim. `isDone` looks at the machine, so a run after a failed or
 * finished one skips what is there. A step without `isDone` runs every time.
 */
export type SetupStep = {
  doing: string;
  already?: string;
  isDone?: () => Promise<boolean>;
  run: () => Promise<void>;
};

/** Runs each step that is not done, then checks that it is. */
export async function runSetup(steps: readonly SetupStep[], log: (line: string) => void): Promise<void> {
  for (const step of steps) {
    if (step.isDone && (await step.isDone())) {
      log(step.already ?? step.doing);
      continue;
    }
    log(step.doing);
    await step.run();
    if (step.isDone && !(await step.isDone())) {
      throw new Error(`This step finished, but its result is missing: ${step.doing}`);
    }
  }
}

/** The SHA-256 that a release's `SHA256SUMS` lists for a file. */
export function sumFor(sums: string, file: string): string | undefined {
  for (const line of sums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name?.replace(/^\*/, '') === file) return hash.toLowerCase();
  }
  return undefined;
}

/** What `x86sim-aot setup check` says about the parts the setup can fix. */
export function readCheck(output: string): { darlingOk: boolean; setupNeeded: boolean } {
  return {
    darlingOk: /^ok\s+Darling\b/m.test(output),
    setupNeeded: /^setup needed: true/m.test(output),
  };
}

type Run = { code: number | null; output: string };

/** Runs a command to its exit. `capture` keeps its output, else the output goes to the terminal. */
function run(launch: Launch, capture = false): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      env: { ...process.env, ...launch.env },
      ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

async function mustRun(launch: Launch, what: string): Promise<void> {
  const { code } = await run(launch);
  if (code !== 0) throw new Error(`${what} failed (exit ${code}). Its output is above.`);
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
  return response;
}

/** Downloads x86Sim's AppImage from its GitHub release and checks it against the release's SHA256SUMS. */
async function downloadAppImage(file: string, log: (line: string) => void): Promise<void> {
  const base = `https://github.com/x86sim/x86sim/releases/download/v${X86SIM_VERSION}/`;
  const name = path.basename(file);
  const want = sumFor(await (await fetchOk(`${base}SHA256SUMS`)).text(), name);
  if (!want) throw new Error(`The SHA256SUMS of x86Sim ${X86SIM_VERSION} does not list ${name}.`);
  const response = await fetchOk(base + name);
  const total = Number(response.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  let received = 0;
  let shown = 0;
  const body = Readable.fromWeb(response.body as never);
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
    const tenth = total ? Math.floor((received / total) * 10) : 0;
    if (tenth > shown) {
      shown = tenth;
      log(`  ${tenth * 10}% of ${Math.round(total / 1e6)} MB`);
    }
  });
  await mkdir(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  try {
    await pipeline(body, createWriteStream(part));
    const got = hash.digest('hex');
    if (got !== want) throw new Error(`The download of ${name} has SHA-256 ${got}, not ${want}.`);
    await chmod(part, 0o755);
    await rename(part, file);
  } finally {
    await rm(part, { force: true });
  }
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** `agent-device-x86sim setup`: x86Sim, iOS and a phone, without the launcher's window. */
export async function setup(
  options: SetupOptions,
  log: (line: string) => void,
  environment: Environment = systemEnvironment(),
): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`x86Sim runs on x86-64 Linux, and this is ${process.platform} on ${process.arch}.`);
  }
  const dataDir = x86simDataDir(environment.env, environment.home);
  const appImageFile = path.join(environment.home, 'x86sim', `x86sim-${X86SIM_VERSION}-x86_64.AppImage`);

  /** The AppImage named by the flag or the environment, else the tested release in ~/x86sim, downloaded if missing. */
  let appImage: string | undefined;
  const runAppImage = async (args: string[], what: string): Promise<void> => {
    if (!appImage) {
      const given = options.appimage ?? environment.env.X86SIM_APPIMAGE;
      appImage = given ? path.resolve(environment.cwd, given) : appImageFile;
      if (!(await environment.isExecutable(appImage))) {
        if (given) throw new Error(`The x86Sim AppImage ${appImage} is missing or not executable.`);
        log(`Downloading x86Sim ${X86SIM_VERSION} to ${appImage}.`);
        await downloadAppImage(appImage, log);
      }
    }
    // Extracted for each run, so the setup needs no FUSE. The AppImage leaves its 900 MB extract in
    // TMPDIR, so each run gets a folder of its own that is removed after.
    const tmp = await mkdtemp(path.join(tmpdir(), 'agent-device-x86sim-appimage-'));
    try {
      await mustRun({ command: appImage, args, env: { APPIMAGE_EXTRACT_AND_RUN: '1', TMPDIR: tmp } }, what);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  };

  const x86sim = (): Promise<X86Sim> => findX86Sim(undefined, environment);
  const check = async () => {
    const { code, output } = await run((await x86sim()).aot(['setup', 'check']), true);
    return { code, output, ...readCheck(output) };
  };
  const phones = async () => listPhones(dataDir, environment);
  const phonePath = async () => {
    try {
      return (await findPhone(options.device, dataDir, environment)).path;
    } catch (error) {
      const [first] = await phones();
      if (!options.device && first) return first.path;
      throw error;
    }
  };

  const steps: SetupStep[] = [
    {
      doing: `Unpacking x86Sim into ${dataDir}.`,
      already: `x86Sim is unpacked in ${dataDir}.`,
      isDone: () =>
        x86sim().then(
          () => true,
          (error: unknown) => {
            if (error instanceof NotSetUpError) return false;
            throw error;
          },
        ),
      run: () => runAppImage(['version'], 'Unpacking x86Sim'),
    },
    {
      doing:
        'Installing the simulator host under /opt/x86sim, as the launcher does where user namespaces are blocked. ' +
        'This asks for your password once.',
      already: 'The simulator host is ready.',
      isDone: async () => (await check()).darlingOk,
      run: () => runAppImage(['aot', 'setup', 'install-darling'], 'Installing the simulator host'),
    },
    {
      doing: "Checking this machine with x86Sim's own check.",
      run: async () => {
        const { code, output } = await check();
        log(output.trimEnd().replace(/^/gm, '  '));
        if (code !== 0)
          throw new Error("x86Sim's check of this machine failed. Fix what it lists, then run setup again.");
      },
    },
    {
      doing: 'Downloading iOS 27.2 from Apple. It is about 8 GB and unpacks to 30 GB, so this takes 10 to 40 minutes.',
      already: 'iOS 27.2 is downloaded.',
      isDone: () => exists(path.join(dataDir, 'runtimes', RUNTIME_DIR, 'RuntimeRoot', 'usr')),
      run: async () => {
        for (let attempt = 1; ; attempt += 1) {
          const { code } = await run((await x86sim()).cli(['runtime', 'fetch', RUNTIME_BUILD]));
          if (code === 0) return;
          if (attempt === FETCH_ATTEMPTS) throw new Error(`The download of iOS failed ${FETCH_ATTEMPTS} times.`);
          log(`The download stopped. Resuming, attempt ${attempt + 1} of ${FETCH_ATTEMPTS}.`);
        }
      },
    },
    {
      doing: `Creating the phone ${options.device ?? options.model}, an ${options.model}.`,
      already: 'A phone exists.',
      isDone: async () => {
        const all = await phones();
        if (!options.device) return all.length > 0;
        const name = options.device.toLowerCase();
        return all.some((phone) => phone.folder === options.device || phone.name.toLowerCase() === name);
      },
      run: async () =>
        mustRun(
          (await x86sim()).cli([
            'device',
            'create',
            '--model',
            options.model,
            ...(options.device ? [options.device] : []),
          ]),
          'Creating the phone',
        ),
    },
    {
      doing: 'Pre-translating iOS for this processor, so the phone boots and runs faster. This takes under a minute.',
      already: 'iOS is pre-translated.',
      isDone: async () => {
        const status = await run((await x86sim()).aot(['--device', await phonePath(), 'status', '--json']), true);
        try {
          const image = JSON.parse(status.output) as { image_present?: boolean; missing?: number };
          return image.image_present === true && image.missing === 0;
        } catch {
          return false;
        }
      },
      run: async () => mustRun((await x86sim()).aot(['--device', await phonePath(), 'update']), 'Pre-translating'),
    },
    {
      doing: "Marking the setup as done, so x86Sim's launcher opens on its devices.",
      already: "x86Sim's launcher knows the setup is done.",
      isDone: async () => !(await check()).setupNeeded,
      run: async () => mustRun((await x86sim()).aot(['setup', 'done']), 'Marking the setup as done'),
    },
  ];

  await runSetup(steps, log);
  const phone = await findPhone(options.device, dataDir, environment).catch(async () => (await phones())[0]);
  log(
    [
      `Done. x86Sim is set up with the phone ${phone?.name ?? options.model}.`,
      'Next, run:',
      '  agent-device plugins add agent-device-x86sim',
      '  export AGENT_DEVICE_SESSION=x86sim',
      '  agent-device connect x86sim',
      '  agent-device open com.apple.Preferences',
      'The first open boots the phone, which takes up to 6 minutes.',
      'If agent-device runs on another machine, run npx agent-device-x86sim serve here instead.',
    ].join('\n'),
  );
}
