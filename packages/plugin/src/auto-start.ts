import type { RunningServer, StartOptions } from './cli/start-server.ts';
import { NotSetUpError } from './cli/discovery.ts';
import { discoverTarget } from './cli/system.ts';
import type { Target } from './cli/system.ts';

/**
 * The phone to start a server for, when agent-device runs on the machine that has x86Sim. That
 * is a Linux machine where no server address was given and x86Sim is set up. Anything else means
 * a server runs somewhere else, and `undefined` leaves the address alone. A machine that has
 * x86Sim but no phone, or several phones to choose from, is an error that names the fix.
 */
export async function findAutoTarget(
  endpoint: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  device: string | undefined,
  platform: NodeJS.Platform = process.platform,
  discover: typeof discoverTarget = discoverTarget,
): Promise<Target | undefined> {
  if (endpoint ?? env.X86SIM_WEBDRIVER_ENDPOINT) return undefined;
  if (platform !== 'linux') return undefined;
  try {
    return await discover({ appimage: env.X86SIM_APPIMAGE, device });
  } catch (error) {
    if (error instanceof NotSetUpError) return undefined;
    throw error;
  }
}

type StartServer = (options: StartOptions) => Promise<RunningServer>;

const loadStartServer: StartServer = async (options) => (await import('./cli/start-server.ts')).startServer(options);

/** One server for the daemon, started on the first session and closed with the plugin. */
export function createAutoServer(start: StartServer = loadStartServer) {
  let running: Promise<RunningServer> | undefined;
  return {
    async endpoint(target: Target): Promise<string> {
      running ??= start({
        target,
        host: '127.0.0.1',
        port: 0,
        verbose: false,
        log: (line) => process.stderr.write(`${line}\n`),
      });
      try {
        return (await running).endpoint;
      } catch (error) {
        running = undefined;
        throw error;
      }
    },
    async close(): Promise<void> {
      const server = running;
      running = undefined;
      await (await server?.catch(() => undefined))?.close();
    },
  };
}
