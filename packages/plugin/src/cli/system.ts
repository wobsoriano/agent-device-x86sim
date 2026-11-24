import { access, constants, readFile, readdir, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Environment } from './discovery.ts';
import { findPhone, findX86Sim } from './discovery.ts';
import type { X86Sim } from './install.ts';
import { isPhoneRunning } from './running.ts';

/** The machine this process runs on. */
export function systemEnvironment(): Environment {
  return {
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    listDir: (dir) => readdir(dir).catch(() => []),
    readText: (file) => readFile(file, 'utf8').catch(() => undefined),
    readLink: (file) => readlink(file).catch(() => undefined),
    isExecutable: (file) =>
      access(file, constants.X_OK).then(
        () => true,
        () => false,
      ),
    isRunning: isPhoneRunning,
  };
}

export type Target = {
  x86sim: X86Sim;
  /** The phone's folder. Absolute. */
  device: string;
  /** The name the launcher shows. */
  deviceName: string;
};

/** The x86Sim and the phone on this machine, or an error that names the fix. */
export async function discoverTarget(
  flags: { appimage?: string | undefined; device?: string | undefined },
  environment: Environment = systemEnvironment(),
): Promise<Target> {
  const x86sim = await findX86Sim(flags.appimage, environment);
  const phone = await findPhone(flags.device, x86sim.dataDir, environment);
  return { x86sim, device: phone.path, deviceName: phone.name };
}
