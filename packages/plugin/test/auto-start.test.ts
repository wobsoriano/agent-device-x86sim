import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { createAutoServer, findAutoTarget } from '../src/auto-start.ts';
import { NotSetUpError } from '../src/cli/discovery.ts';
import type { RunningServer } from '../src/cli/start-server.ts';

const TARGET = {
  x86sim: {
    label: 'x86Sim 0.5.3',
    dataDir: '/x',
    cli: () => ({ command: 'x', args: [], env: {} }),
    boot: () => ({ command: 'x', args: [], env: {} }),
  },
  device: '/x/var/device-a64-iphone-17-pro',
  deviceName: 'iPhone 17 Pro',
};
const discover = async () => TARGET;

test('on Linux with no endpoint, the discovered phone is the one to start a server for', async () => {
  assert.deepEqual(await findAutoTarget(undefined, {}, undefined, 'linux', discover), TARGET);
});

test('an endpoint option or X86SIM_WEBDRIVER_ENDPOINT means the server is elsewhere', async () => {
  assert.equal(await findAutoTarget('http://box:4723', {}, undefined, 'linux', discover), undefined);
  assert.equal(
    await findAutoTarget(undefined, { X86SIM_WEBDRIVER_ENDPOINT: 'http://box:4723' }, undefined, 'linux', discover),
    undefined,
  );
});

test('on macOS the server is always elsewhere', async () => {
  assert.equal(await findAutoTarget(undefined, {}, undefined, 'darwin', discover), undefined);
});

test('a Linux machine where x86Sim is not set up leaves the address alone', async () => {
  const missing = async () => {
    throw new NotSetUpError('x86Sim is not set up.');
  };
  assert.equal(await findAutoTarget(undefined, {}, undefined, 'linux', missing), undefined);
});

test('any other discovery error, such as two phones to choose from, is reported', async () => {
  const ambiguous = async () => {
    throw new Error('There is more than one phone.');
  };
  await assert.rejects(findAutoTarget(undefined, {}, undefined, 'linux', ambiguous), /more than one phone/);
});

test('X86SIM_APPIMAGE and the chosen phone are passed on to discovery', async () => {
  let seen: unknown;
  await findAutoTarget(undefined, { X86SIM_APPIMAGE: '/env/x86sim.AppImage' }, 'iPhone SE', 'linux', async (flags) => {
    seen = flags;
    return TARGET;
  });
  assert.deepEqual(seen, { appimage: '/env/x86sim.AppImage', device: 'iPhone SE' });
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
