import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, test } from 'vite-plus/test';
import { FakeBackend } from '../../server/src/backends/fake.ts';
import { createServer } from '../../server/src/server.ts';
import { uploadApp } from '../src/upload-app.ts';

let scratch = '';
let appDir = '';
const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'upload-app-test-'));
  appDir = path.join(scratch, 'Hello.app');
  await mkdir(appDir);
  await writeFile(path.join(appDir, 'Info.plist'), '<plist/>');
});
afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await rm(scratch, { recursive: true, force: true });
});

const params = (appPath: string) => ({ appPath, app: 'com.example.hello' }) as never;

test('the app reaches the server, and the engine gets back the path it was unpacked to', async () => {
  const endpoint = await listen(
    createServer({ backend: new FakeBackend(), uploadDir: path.join(scratch, 'uploads'), log: () => undefined }),
  );
  const { appReference } = await uploadApp(endpoint)(params(appDir));
  assert.equal(path.basename(appReference), 'Hello.app');
  assert.equal(await readFile(path.join(appReference, 'Info.plist'), 'utf8'), '<plist/>');
});

test('a server from before uploads names the update to make', async () => {
  const endpoint = await listen(
    createHttpServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ value: { error: 'unknown command', message: 'Unknown command' } }));
    }),
  );
  await assert.rejects(uploadApp(endpoint)(params(appDir)), /takes no app uploads\. Update agent-device-x86sim/);
});
