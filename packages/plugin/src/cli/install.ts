import path from 'node:path';

/** A command to spawn. `env` is added to the environment of this process. */
export type Launch = { command: string; args: string[]; env: Record<string, string>; cwd?: string };

/** The ways to run x86Sim's command line and its boot script. */
export type X86Sim = {
  /** For the progress lines, such as `x86Sim 0.5.3 in /home/u/.local/share/x86sim`. */
  label: string;
  /** Where x86Sim keeps its phones, in `var/`. */
  dataDir: string;
  /** `x86sim <args>`. */
  cli(args: readonly string[]): Launch;
  /** The script that boots and stops arm64 phones. */
  boot(): Launch;
};

export const BOOT_SCRIPT = 'cli/libexec/arm64/boot-a64.sh';

type Env = Readonly<Record<string, string | undefined>>;

/** Where x86Sim copies itself and keeps phones, as its AppImage decides it. */
export const x86simDataDir = (env: Env, home: string): string =>
  env.X86SIM_DATA || path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'x86sim');

/** Where x86Sim keeps its scratch files. */
export const x86simCacheDir = (env: Env, home: string): string =>
  env.X86SIM_CACHE || path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'x86sim');

const versionParts = (version: string) => version.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : -1));

/** Compares versions part by part. A part that is not a number, such as `pre8`, sorts below a missing one. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export const newestVersion = (versions: readonly string[]): string | undefined =>
  [...versions].sort(compareVersions).at(-1);

export type DataDirParts = {
  dataDir: string;
  cacheDir: string;
  version: string;
  darlingId: string;
  darlingMode: 'system' | 'userns';
  /** `$PATH` of this process. */
  path: string;
};

/**
 * x86Sim's AppImage copies its payload into the data folder, and phones run from there after
 * the launcher exits. This runs the copy the way the AppImage's `AppRun` would, with the same
 * environment.
 */
export function dataDirInstall(parts: DataDirParts): X86Sim {
  const app = path.join(parts.dataDir, 'app', parts.version);
  const env = {
    X86SIM_DARLING_MODE: parts.darlingMode,
    X86SIM_ROOT: parts.dataDir,
    X86SIM_SCRATCH: parts.cacheDir,
    X86SIM_APP: app,
    X86SIM_VERSION: parts.version,
    X86SIM_DARLING_ID: parts.darlingId,
    X86SIM_PYLIB: path.join(app, 'pylib'),
    A64_PREFIX_HEAL: '0',
    PATH: `${path.join(app, 'bin')}:${parts.path}`,
  };
  return {
    label: `x86Sim ${parts.version} in ${parts.dataDir}`,
    dataDir: parts.dataDir,
    cli: (args) => ({ command: path.join(app, 'cli', 'x86sim'), args: [...args], env }),
    boot: () => ({ command: '/bin/sh', args: ['-c', BOOT_SCRIPT], env, cwd: parts.dataDir }),
  };
}

/** An AppImage the user named, which runs everything through its own entry point. */
export function appImageInstall(appImage: string, dataDir: string): X86Sim {
  return {
    label: appImage,
    dataDir,
    cli: (args) => ({ command: appImage, args: ['x86sim', ...args], env: {} }),
    boot: () => ({ command: appImage, args: ['shell', '-c', BOOT_SCRIPT], env: {} }),
  };
}
