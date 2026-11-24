import { hostname } from 'node:os';
import type { ServeOptions } from './args.ts';
import { startServer } from './start-server.ts';
import { discoverTarget } from './system.ts';

const log = (line: string) => process.stderr.write(`${line}\n`);

/** The lines that tell the user what to run next. */
export function readyMessage(endpoint: string, device: string): string {
  const port = new URL(endpoint).port;
  return [
    `Ready. The server for the phone ${device} answers at ${endpoint}.`,
    'On the machine that runs agent-device, run:',
    '  agent-device plugins add agent-device-x86sim',
    '  agent-device connect x86sim',
    `If that is another machine, forward the port first: ssh -N -L ${port}:localhost:${port} <user>@${hostname()}`,
    'Stop the server with Ctrl+C. The phone keeps running.',
  ].join('\n');
}

/** `agent-device-x86sim serve`. Returns when the server is ready. The open server keeps the process alive. */
export async function serve(options: ServeOptions): Promise<void> {
  const target = await discoverTarget(options);
  log(`Using ${target.x86sim.label}`);
  log(`Using the phone ${target.deviceName}`);
  const server = await startServer({ target, host: options.host, port: options.port, verbose: options.verbose, log });
  log(readyMessage(server.endpoint, target.deviceName));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void server.close().then(() => process.exit(0)));
  }
}
