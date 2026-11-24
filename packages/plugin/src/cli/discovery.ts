import path from 'node:path';

/** The names in a folder, or none when it does not exist. */
export type ListDir = (dir: string) => Promise<readonly string[]>;

export type Environment = {
  /** Variables of the process, such as `X86SIM_APPIMAGE` and `XDG_DATA_HOME`. */
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  cwd: string;
  listDir: ListDir;
  isExecutable: (file: string) => Promise<boolean>;
};

export const RELEASES_URL = 'https://github.com/x86sim/x86sim/releases/latest';
const APPIMAGE_NAME = /^x86sim-(\d+(?:\.\d+)*)-x86_64\.AppImage$/;
const DEVICE_PREFIX = 'device-a64-';

/** A version compared part by part, so 0.10.0 is newer than 0.9.1. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export const appImageFolders = ({ home, cwd }: Pick<Environment, 'home' | 'cwd'>): string[] => [
  path.join(home, 'x86sim'),
  path.join(home, 'Applications'),
  path.join(home, 'Downloads'),
  cwd,
];

/** The newest `x86sim-<version>-x86_64.AppImage` among the folders. The earlier folder wins a tie. */
export async function newestAppImage(folders: readonly string[], listDir: ListDir): Promise<string | undefined> {
  let best: { file: string; version: string } | undefined;
  for (const folder of folders) {
    for (const name of await listDir(folder)) {
      const version = APPIMAGE_NAME.exec(name)?.[1];
      if (version && (!best || compareVersions(version, best.version) > 0)) {
        best = { file: path.join(folder, name), version };
      }
    }
  }
  return best?.file;
}

/** The AppImage from `--appimage`, else `$X86SIM_APPIMAGE`, else the newest one in the usual folders. */
export async function findAppImage(flag: string | undefined, environment: Environment): Promise<string> {
  const given = flag ?? environment.env.X86SIM_APPIMAGE;
  const folders = appImageFolders(environment);
  const file = given ? path.resolve(environment.cwd, given) : await newestAppImage(folders, environment.listDir);
  if (!file) {
    throw new Error(
      `No x86Sim AppImage found. Looked for x86sim-<version>-x86_64.AppImage in ${folders.join(', ')}.\n` +
        `Download one from ${RELEASES_URL}, or pass --appimage PATH or set X86SIM_APPIMAGE.`,
    );
  }
  if (!(await environment.isExecutable(file))) {
    throw new Error(`The x86Sim AppImage ${file} is missing or not executable. Run: chmod +x ${file}`);
  }
  return file;
}

/** Where x86Sim keeps its data, which holds the phones in `var/`. */
export const x86simDataDir = ({ env, home }: Pick<Environment, 'env' | 'home'>): string =>
  path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'x86sim');

/** The phone's folder from `--device` (a name or a folder), else the only phone x86Sim has created. */
export async function findDevice(
  flag: string | undefined,
  appImage: string,
  environment: Environment,
): Promise<string> {
  const varDir = path.join(x86simDataDir(environment), 'var');
  if (flag) {
    const folder = flag.includes('/') ? path.resolve(environment.cwd, flag) : path.join(varDir, flag);
    if (!(await environment.listDir(folder)).includes('sim.env')) {
      throw new Error(
        `${folder} is not a phone folder, because it has no sim.env. List the phones with: ${appImage} x86sim device list`,
      );
    }
    return folder;
  }
  const phones = (await environment.listDir(varDir)).filter((name) => name.startsWith(DEVICE_PREFIX)).sort();
  if (phones.length === 0) {
    throw new Error(
      `No phone found in ${varDir}. Create one with: ${appImage} x86sim device create --model "iPhone 17 Pro"`,
    );
  }
  if (phones.length > 1) {
    throw new Error(`More than one phone in ${varDir}: ${phones.join(', ')}. Pick one with --device NAME.`);
  }
  return path.join(varDir, phones[0] as string);
}
