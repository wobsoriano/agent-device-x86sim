import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, test } from 'vite-plus/test';
import { FAKE_CONTINUE_FRAME, FakeBackend, fakeRoutes } from '../src/backends/fake.ts';
import { createServer } from '../src/server.ts';

const requestLog: string[] = [];
const backend = new FakeBackend();
const server = createServer({
  backend,
  extraRoutes: fakeRoutes(backend),
  log: (line) => requestLog.push(line),
});
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as any };
}

test('session lifecycle: create, source, tap, delete', async () => {
  const created = await call('POST', '/session', {
    capabilities: { alwaysMatch: { platformName: 'iOS', 'appium:deviceName': 'x86Sim iPhone' } },
  });
  assert.equal(created.status, 200);
  const sessionId: string = created.json.value.sessionId;
  assert.equal(created.json.value.capabilities['appium:deviceName'], 'x86Sim iPhone');

  const source = await call('GET', `/session/${sessionId}/source`);
  assert.equal(source.status, 200);
  assert.match(source.json.value, /<XCUIElementTypeButton [^>]*name="Continue"/);

  const frame = FAKE_CONTINUE_FRAME;
  const x = frame.x + frame.width / 2;
  const y = frame.y + frame.height / 2;
  const tap = await call('POST', `/session/${sessionId}/actions`, {
    actions: [
      {
        type: 'pointer',
        id: 'tap',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x, y },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  });
  assert.equal(tap.status, 200);

  const log = await call('GET', '/__fake/log');
  const touch = log.json.calls.find((entry: { call: string }) => entry.call === 'touch');
  assert.deepEqual(touch.args.events, [
    { kind: 'down', at: { x, y } },
    { kind: 'up', at: { x, y } },
  ]);

  const deleted = await call('DELETE', `/session/${sessionId}`);
  assert.equal(deleted.status, 200);
  const afterDelete = await call('GET', `/session/${sessionId}/source`);
  assert.equal(afterDelete.status, 404);
  assert.equal(afterDelete.json.value.error, 'invalid session id');
});

test('only one session at a time', async () => {
  const first = await call('POST', '/session', { capabilities: {} });
  const second = await call('POST', '/session', { capabilities: {} });
  assert.equal(second.status, 500);
  assert.equal(second.json.value.error, 'session not created');
  await call('DELETE', `/session/${first.json.value.sessionId}`);
});

test('an unimplemented route is the W3C unknown command error', async () => {
  const created = await call('POST', '/session', { capabilities: {} });
  const id = created.json.value.sessionId;
  const back = await call('POST', `/session/${id}/back`);
  assert.equal(back.status, 404);
  assert.equal(back.json.value.error, 'unknown command');
  await call('DELETE', `/session/${id}`);
});

test('malformed actions are an invalid argument error', async () => {
  const created = await call('POST', '/session', { capabilities: {} });
  const id = created.json.value.sessionId;
  const bad = await call('POST', `/session/${id}/actions`, { nope: true });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.value.error, 'invalid argument');
  await call('DELETE', `/session/${id}`);
});

test('every request is logged as one line', () => {
  assert.ok(requestLog.length > 0);
  for (const line of requestLog) assert.match(line, /^[A-Z]+ \S+ -> \d{3} \d+ms/);
  assert.ok(requestLog.some((line) => line.startsWith('POST /session -> 200')));
});
