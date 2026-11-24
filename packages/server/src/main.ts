import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import { FakeBackend, fakeRoutes } from './backends/fake.ts';
import { createServer } from './server.ts';

const { values } = parseArgs({
  options: {
    backend: { type: 'string', default: 'fake' },
    port: { type: 'string', default: '4723' },
    host: { type: 'string', default: '127.0.0.1' },
  },
});

if (values.backend !== 'fake') {
  process.stderr.write(`Unknown backend "${values.backend}". Available: fake.\n`);
  process.exit(2);
}

const backend = new FakeBackend();
const server = createServer({ backend, extraRoutes: fakeRoutes(backend) });

server.listen(Number(values.port), values.host, () => {
  const { port } = server.address() as AddressInfo;
  process.stdout.write(`x86sim-webdriver listening on http://${values.host}:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
