import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { FakeBackend, fakeRoutes } from './backends/fake.ts';
import { X86SimBackend } from './backends/x86sim.ts';
import type { Route } from './router.ts';
import { createServer } from './server.ts';
import type { Backend } from './types.ts';

const { values } = parseArgs({
  options: {
    backend: { type: 'string', default: 'fake' },
    port: { type: 'string', default: '4723' },
    host: { type: 'string', default: '127.0.0.1' },
    appimage: { type: 'string' },
    device: { type: 'string' },
  },
});

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function createBackend(): { backend: Backend; extraRoutes: Route[] } {
  switch (values.backend) {
    case 'fake': {
      const backend = new FakeBackend();
      return { backend, extraRoutes: fakeRoutes(backend) };
    }
    case 'x86sim': {
      if (!values.appimage || !values.device) fail('--backend x86sim needs --appimage <path> and --device <dir>.');
      const backend = new X86SimBackend({
        appImage: path.resolve(values.appimage),
        device: path.resolve(values.device),
      });
      return { backend, extraRoutes: [] };
    }
    default:
      return fail(`Unknown backend "${values.backend}". Available: fake, x86sim.`);
  }
}

const { backend, extraRoutes } = createBackend();
const server = createServer({ backend, extraRoutes });

server.listen(Number(values.port), values.host, () => {
  const { port } = server.address() as AddressInfo;
  process.stdout.write(`x86sim-webdriver listening on http://${values.host}:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
