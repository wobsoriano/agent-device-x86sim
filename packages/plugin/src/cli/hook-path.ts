import { access } from 'node:fs/promises';
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
