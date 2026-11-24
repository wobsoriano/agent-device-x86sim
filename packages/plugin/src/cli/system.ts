import { access, constants, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Environment } from './discovery.ts';
import { findAppImage, findDevice } from './discovery.ts';

/** The machine this process runs on. */
export function systemEnvironment(): Environment {
  return {
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    listDir: (dir) => readdir(dir).catch(() => []),
    isExecutable: (file) =>
      access(file, constants.X_OK).then(
        () => true,
        () => false,
      ),
  };
}

export type Target = { appImage: string; device: string };

/** The AppImage and phone x86Sim has on this machine, or an error that names the fix. */
export async function discoverTarget(
  flags: { appimage?: string | undefined; device?: string | undefined },
  environment: Environment = systemEnvironment(),
): Promise<Target> {
  const appImage = await findAppImage(flags.appimage, environment);
  return { appImage, device: await findDevice(flags.device, appImage, environment) };
}
