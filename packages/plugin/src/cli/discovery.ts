import path from 'node:path';
import { appImageInstall, dataDirInstall, newestVersion, x86simCacheDir, x86simDataDir } from './install.ts';
import type { X86Sim } from './install.ts';

/** The names in a folder, or none when it does not exist. */
export type ListDir = (dir: string) => Promise<readonly string[]>;

export type Environment = {
  /** Variables of the process, such as `X86SIM_APPIMAGE` and `XDG_DATA_HOME`. */
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  cwd: string;
  listDir: ListDir;
  /** The text of a file, or `undefined` when there is none. */
  readText: (file: string) => Promise<string | undefined>;
  /** Where a symbolic link points, or `undefined` when it is not one. */
  readLink: (file: string) => Promise<string | undefined>;
  isExecutable: (file: string) => Promise<boolean>;
  /** Whether the phone in this folder runs. */
  isRunning: (device: string) => Promise<boolean>;
};

/** A phone x86Sim has created. */
export type Phone = {
  /** The folder in `var/`, such as `device-a64-iphone-17-pro`. */
  folder: string;
  path: string;
  /** The name the launcher shows, such as `iPhone 17 Pro`. */
  name: string;
};

export const QUICK_START_URL = 'https://github.com/x86sim/x86sim#quick-start';
const DEVICE_PREFIX = 'device-a64-';

/** x86Sim has not been set up on this machine. Callers that can run without it catch this one. */
export class NotSetUpError extends Error {}

/**
 * x86Sim as `--appimage` or `$X86SIM_APPIMAGE` names it, else the newest copy in the data
 * folder. Running an AppImage copies its payload there, whatever folder the AppImage is in.
 */
export async function findX86Sim(flag: string | undefined, environment: Environment): Promise<X86Sim> {
  const { env, home, cwd } = environment;
  const dataDir = x86simDataDir(env, home);
  const given = flag ?? env.X86SIM_APPIMAGE;
  if (given) {
    const file = path.resolve(cwd, given);
    if (!(await environment.isExecutable(file))) {
      throw new Error(`The x86Sim AppImage ${file} is missing or not executable. Run: chmod +x ${file}`);
    }
    return appImageInstall(file, dataDir);
  }
  const appDir = path.join(dataDir, 'app');
  const complete: string[] = [];
  for (const version of await environment.listDir(appDir)) {
    if ((await environment.listDir(path.join(appDir, version))).includes('.complete')) complete.push(version);
  }
  const version = newestVersion(complete);
  if (!version) throw new NotSetUpError(`x86Sim is not set up. Follow ${QUICK_START_URL}`);
  const mode = env.X86SIM_DARLING_MODE;
  const link = await environment.readLink(path.join(dataDir, 'darling-prefix'));
  return dataDirInstall({
    dataDir,
    cacheDir: x86simCacheDir(env, home),
    version,
    darlingId: (await environment.readText(path.join(appDir, version, 'DARLING_ID')))?.trim() ?? '',
    darlingMode: mode === 'system' || mode === 'userns' ? mode : link?.includes('darling-userns') ? 'userns' : 'system',
    path: env.PATH ?? '',
  });
}

async function listPhones(dataDir: string, environment: Environment): Promise<Phone[]> {
  const varDir = path.join(dataDir, 'var');
  const folders = (await environment.listDir(varDir)).filter((name) => name.startsWith(DEVICE_PREFIX)).sort();
  return await Promise.all(
    folders.map(async (folder) => ({
      folder,
      path: path.join(varDir, folder),
      name: (await environment.readText(path.join(varDir, folder, 'name')))?.trim() || folder,
    })),
  );
}

const quoted = (phones: readonly Phone[]) => phones.map((phone) => `"${phone.name}"`).join(', ');

const pick = (phone: Phone) => `agent-device connect x86sim --device "${phone.name}"`;

/**
 * The phone to use. `--device` names it, by the name the launcher shows or by its folder, or is
 * the folder's path. Without it, the phone that runs wins, else the only phone.
 */
export async function findPhone(flag: string | undefined, dataDir: string, environment: Environment): Promise<Phone> {
  const phones = await listPhones(dataDir, environment);
  if (flag?.includes('/')) {
    const folder = path.resolve(environment.cwd, flag);
    if (!(await environment.listDir(folder)).includes('sim.env')) {
      throw new Error(`${folder} is not a phone folder, because it has no sim.env.`);
    }
    return { folder: path.basename(folder), path: folder, name: path.basename(folder) };
  }
  if (flag) {
    const lower = flag.toLowerCase();
    const matches = phones.filter((phone) => phone.folder === flag || phone.name.toLowerCase() === lower);
    const [only] = matches;
    if (only && matches.length === 1) return only;
    if (only) {
      throw new Error(
        `More than one phone is named "${flag}". Use a folder name: ${matches.map((p) => p.folder).join(', ')}.`,
      );
    }
    throw new Error(
      phones.length === 0
        ? `No phone found in ${path.join(dataDir, 'var')}. Create one on the Setup page of the x86Sim launcher. ${QUICK_START_URL}`
        : `No phone is named "${flag}". The phones are ${quoted(phones)}.`,
    );
  }
  const [first] = phones;
  if (!first) {
    throw new Error(
      `No phone found in ${path.join(dataDir, 'var')}. Create one on the Setup page of the x86Sim launcher. ${QUICK_START_URL}`,
    );
  }
  const running: Phone[] = [];
  for (const phone of phones) if (await environment.isRunning(phone.path)) running.push(phone);
  const [firstRunning] = running;
  if (firstRunning && running.length === 1) return firstRunning;
  if (phones.length === 1) return first;
  throw new Error(
    `${running.length > 1 ? 'More than one phone runs' : 'There is more than one phone and none runs'}. ` +
      `The phones are ${quoted(running.length > 1 ? running : phones)}. Pick one with ${pick(running[0] ?? first)}.`,
  );
}
