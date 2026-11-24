import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { createAutoServer, findAutoTarget } from '../src/auto-start.ts';
import type { RunningServer } from '../src/cli/start-server.ts';

const TARGET = { appImage: '/x/x86sim.AppImage', device: '/x/var/device-a64-iphone-17-pro' };
const discover = async () => TARGET;

test('on Linux with no endpoint, the discovered phone is the one to start a server for', async () => {
  assert.deepEqual(await findAutoTarget(undefined, {}, 'linux', discover), TARGET);
});

test('an endpoint option or X86SIM_WEBDRIVER_ENDPOINT means the server is elsewhere', async () => {
  assert.equal(await findAutoTarget('http://box:4723', {}, 'linux', discover), undefined);
  assert.equal(
    await findAutoTarget(undefined, { X86SIM_WEBDRIVER_ENDPOINT: 'http://box:4723' }, 'linux', discover),
    undefined,
  );
});

test('on macOS the server is always elsewhere', async () => {
  assert.equal(await findAutoTarget(undefined, {}, 'darwin', discover), undefined);
});

test('a Linux machine without x86Sim leaves the address alone instead of failing', async () => {
  const missing = async () => {
    throw new Error('No x86Sim AppImage found.');
  };
  assert.equal(await findAutoTarget(undefined, {}, 'linux', missing), undefined);
});

test('X86SIM_APPIMAGE is passed on to discovery', async () => {
  let seen: unknown;
  await findAutoTarget(undefined, { X86SIM_APPIMAGE: '/env/x86sim.AppImage' }, 'linux', async (flags) => {
    seen = flags;
    return TARGET;
  });
  assert.deepEqual(seen, { appimage: '/env/x86sim.AppImage' });
});

function counting() {
  const started: string[] = [];
  const closed: string[] = [];
  const start = async (): Promise<RunningServer> => {
    const endpoint = `http://127.0.0.1:${40000 + started.length}`;
    started.push(endpoint);
    return { endpoint, close: async () => void closed.push(endpoint) };
  };
  return { start, started, closed };
}

test('later sessions reuse the one server', async () => {
  const { start, started } = counting();
  const auto = createAutoServer(start);
  const [first, second] = await Promise.all([auto.endpoint(TARGET), auto.endpoint(TARGET)]);
  assert.equal(first, second);
  assert.equal(await auto.endpoint(TARGET), first);
  assert.equal(started.length, 1);
});

test('closing stops the server, and a later session starts a new one', async () => {
  const { start, started, closed } = counting();
  const auto = createAutoServer(start);
  const first = await auto.endpoint(TARGET);
  await auto.close();
  assert.deepEqual(closed, [first]);
  assert.notEqual(await auto.endpoint(TARGET), first);
  assert.equal(started.length, 2);
});

test('closing with no server started does nothing', async () => {
  await createAutoServer(counting().start).close();
});

test('a start that fails is not remembered, so the next session tries again', async () => {
  let attempts = 0;
  const auto = createAutoServer(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('The phone is not ready.');
    return { endpoint: 'http://127.0.0.1:1', close: async () => {} };
  });
  await assert.rejects(auto.endpoint(TARGET), /not ready/);
  assert.equal(await auto.endpoint(TARGET), 'http://127.0.0.1:1');
});
