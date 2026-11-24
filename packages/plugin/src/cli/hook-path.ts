import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** The hook's place in the package, relative to the built `dist/` folder. */
const PACKAGED_HOOK = '../ax-hook/libx86sim-ax.dylib';

/** The absolute path of the accessibility hook this package ships, resolved from where it is installed. */
export async function packagedHookPath(moduleUrl: string = import.meta.url): Promise<string> {
  const file = fileURLToPath(new URL(PACKAGED_HOOK, moduleUrl));
  try {
    await access(file);
  } catch {
    throw new Error(`The accessibility hook is missing from this install, at ${file}. Reinstall agent-device-x86sim.`);
  }
  return file;
}

/** Where x86Sim mounts the Linux file system inside the phone. */
const PHONE_MOUNT_OF_HOST = '/Volumes/SystemRoot';

/**
 * The files `sim.env` says the phone loaded into every process, as Linux paths. The phone sees
 * the host file system under `/Volumes/SystemRoot`, so that prefix comes off.
 */
export function insertedLibraries(simEnv: string): string[] {
  const value = /^DYLD_INSERT_LIBRARIES=(.*)$/m.exec(simEnv)?.[1] ?? '';
  return value
    .split(':')
    .filter((entry) => entry !== '')
    .map((entry) => (entry.startsWith(`${PHONE_MOUNT_OF_HOST}/`) ? entry.slice(PHONE_MOUNT_OF_HOST.length) : entry));
}

const digestOf = async (file: string): Promise<string | undefined> =>
  await readFile(file).then(
    (bytes) => createHash('sha256').update(bytes).digest('hex'),
    () => undefined,
  );

/**
 * Whether the phone loaded exactly the hook this package ships. A hook from an older install
 * differs in its bytes, and one whose file is gone from disk counts as different.
 */
export async function loadedHookIsPackaged(simEnv: string, packaged: string): Promise<boolean> {
  const wanted = await digestOf(packaged);
  if (wanted === undefined) return false;
  for (const file of insertedLibraries(simEnv)) {
    if ((await digestOf(file)) === wanted) return true;
  }
  return false;
}
