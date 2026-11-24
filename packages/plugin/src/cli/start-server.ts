import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { X86SimBackend } from '../../../server/src/backends/x86sim.ts';
import { createServer } from '../../../server/src/server.ts';
import { packagedHookPath } from './hook-path.ts';
import { createPhoneControl } from './phone-control.ts';
import { preparePhone } from './phone.ts';
import type { Target } from './system.ts';

export type StartOptions = {
  target: Target;
  host: string;
  /** 0 lets the operating system pick. */
  port: number;
  /** Log every request, and stream x86Sim's boot output. */
  verbose: boolean;
  /** One progress line. */
  log: (line: string) => void;
};

export type RunningServer = {
  /** Where the WebDriver server answers, such as `http://127.0.0.1:4723`. */
  endpoint: string;
  close(): Promise<void>;
};

/** Fails now, not after a boot that takes minutes, when something else holds the port. */
async function assertPortFree(host: string, port: number): Promise<void> {
  if (port === 0) return;
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`Port ${port} on ${host} is in use. Stop what uses it, or pass --port.`)
          : error,
      ),
    );
    probe.listen(port, host, () => probe.close(() => resolve()));
  });
}

/**
 * Brings the phone to ready, then starts the WebDriver server in front of it. `serve` and the
 * plugin's own start-up both call this.
 */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  await assertPortFree(options.host, options.port);
  const hook = await packagedHookPath();
  await preparePhone(
    createPhoneControl({
      x86sim: options.target.x86sim,
      device: options.target.device,
      hook,
      verbose: options.verbose,
      write: (text) => process.stderr.write(text),
    }),
    options.log,
  );
  const server = createServer({
    backend: new X86SimBackend({ cli: (args) => options.target.x86sim.cli(args), device: options.target.device }),
    log: options.verbose ? (line) => process.stderr.write(`${line}\n`) : () => {},
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://${options.host}:${port}`,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}
