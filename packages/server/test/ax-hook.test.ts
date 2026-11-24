import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import path from 'node:path';
import { test } from 'vite-plus/test';
import {
  SPRINGBOARD_BUNDLE_ID,
  firstMatching,
  hookSocketNames,
  parseHookReply,
  readFrontTree,
  readFrontTreeWhenListening,
} from '../src/backends/ax-hook.ts';
import { parseSimulatorUdid } from '../src/backends/simhid.ts';
import type { AxNode } from '../src/types.ts';

const frame = { x: 0, y: 0, width: 402, height: 874 };

const button = (label: string): AxNode => ({
  type: 'XCUIElementTypeButton',
  label,
  frame: { x: 16, y: 293, width: 370, height: 52 },
  enabled: true,
  visible: true,
  children: [],
});

const application = (...windowChildren: AxNode[]): AxNode => ({
  type: 'XCUIElementTypeApplication',
  frame,
  enabled: true,
  visible: true,
  children:
    windowChildren.length === 0
      ? []
      : [{ type: 'XCUIElementTypeWindow', frame, enabled: true, visible: true, children: windowChildren }],
});

/** A hook that listens like the real one: `tree\n` in, one JSON line out. */
async function fakeHook(
  dir: string,
  udid: string,
  pid: number,
  behavior: 'answer' | 'hang',
  body: string,
): Promise<Server> {
  const server = createServer((socket) => {
    socket.on('data', () => {
      if (behavior === 'answer') socket.end(`${body}\n`);
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(path.join(dir, `x86sim-ax-${udid}-${pid}.sock`), resolve));
  return server;
}

const UDID = 'CED9FD5F-23EB-57BD-8736-5DFD6CC9EDDF';
const springboardBody = (front: { pid: number; bundleId: string } | null) =>
  JSON.stringify({ pid: 80, bundleId: SPRINGBOARD_BUNDLE_ID, front, root: application(button('Settings')) });
const appBody = (pid: number, bundleId: string, label: string) =>
  JSON.stringify({ pid, bundleId, root: application(button(label)) });

/** Runs `body` with a runtime directory and closes every fake hook afterwards. */
async function withHooks(
  body: (dir: string, add: (pid: number, behavior: 'answer' | 'hang', json: string) => Promise<void>) => Promise<void>,
) {
  // sockaddr_un holds about 100 bytes, which macOS's per-user temp directory alone nearly fills.
  const dir = await mkdtemp('/tmp/ax-hooks-');
  const servers: Server[] = [];
  try {
    await body(dir, async (pid, behavior, json) => void servers.push(await fakeHook(dir, UDID, pid, behavior, json)));
  } finally {
    for (const server of servers) server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const labelsOf = (root: AxNode) => root.children.flatMap((window) => window.children.map((node) => node.label));

test('the home screen is SpringBoard, and a suspended app that never answers costs no wait', async () => {
  await withHooks(async (dir, add) => {
    await add(80, 'answer', springboardBody(null));
    await add(1817, 'hang', '');
    const started = performance.now();
    const root = await readFrontTree(dir, UDID, 5_000);
    assert.deepEqual(labelsOf(root), ['Settings']);
    assert.ok(performance.now() - started < 1_000, 'the hung app was not waited for');
  });
});

test("with an app in front the tree is that app's, whichever hooks also answer", async () => {
  await withHooks(async (dir, add) => {
    await add(80, 'answer', springboardBody({ pid: 1817, bundleId: 'com.apple.Preferences' }));
    await add(1817, 'answer', appBody(1817, 'com.apple.Preferences', 'General'));
    await add(1900, 'answer', appBody(1900, 'com.apple.mobilesafari', 'Address'));
    await add(2000, 'hang', '');
    assert.deepEqual(labelsOf(await readFrontTree(dir, UDID, 5_000)), ['General']);
  });
});

test('a front app whose hook is missing or silent fails the snapshot with its name', async () => {
  await withHooks(async (dir, add) => {
    await add(80, 'answer', springboardBody({ pid: 1817, bundleId: 'com.apple.Preferences' }));
    await assert.rejects(readFrontTree(dir, UDID, 5_000), /com\.apple\.Preferences \(pid 1817\) has no hook socket/);
    await add(1817, 'hang', '');
    await assert.rejects(readFrontTree(dir, UDID, 300), /did not answer/);
  });
});

test('a front app that binds its hook socket a moment later is waited for', async () => {
  await withHooks(async (dir, add) => {
    await add(80, 'answer', springboardBody({ pid: 1817, bundleId: 'com.apple.Preferences' }));
    setTimeout(() => void add(1817, 'answer', appBody(1817, 'com.apple.Preferences', 'General')), 400);
    const root = await readFrontTreeWhenListening(dir, UDID, 5_000, 5_000, 100);
    assert.equal(JSON.stringify(root).includes('General'), true);
  });
});

test('a front app that never binds a socket fails after the wait, naming the app', async () => {
  await withHooks(async (dir, add) => {
    await add(80, 'answer', springboardBody({ pid: 1817, bundleId: 'com.apple.Preferences' }));
    const started = Date.now();
    await assert.rejects(
      readFrontTreeWhenListening(dir, UDID, 5_000, 600, 100),
      /com\.apple\.Preferences \(pid 1817\) has no hook socket/,
    );
    assert.ok(Date.now() - started >= 400, 'it waited');
  });
});

test('a front app whose hook is silent is not waited for', async () => {
  await withHooks(async (dir, add) => {
    await add(80, 'answer', springboardBody({ pid: 1817, bundleId: 'com.apple.Preferences' }));
    await add(1817, 'hang', '');
    const started = Date.now();
    await assert.rejects(readFrontTreeWhenListening(dir, UDID, 300, 5_000, 100), /did not answer/);
    assert.ok(Date.now() - started < 2_000, 'it failed at once');
  });
});

test('without a SpringBoard answer there is no tree', async () => {
  await withHooks(async (dir, add) => {
    await add(1817, 'answer', appBody(1817, 'com.apple.Preferences', 'General'));
    await assert.rejects(readFrontTree(dir, UDID, 5_000), /SpringBoard's accessibility hook did not answer/);
  });
});

test('a stale socket file left by a dead process is removed', async () => {
  await withHooks(async (dir, add) => {
    const stale = path.join(dir, `x86sim-ax-${UDID}-999.sock`);
    // A process killed with SIGKILL leaves its socket file behind, as a phone process that dies does.
    const script = `require('net').createServer().listen(${JSON.stringify(stale)}, () => process.kill(process.pid, 'SIGKILL'))`;
    spawnSync(process.execPath, ['-e', script]);
    await access(stale);
    await add(80, 'answer', springboardBody(null));
    await readFrontTree(dir, UDID, 5_000);
    await assert.rejects(access(stale), 'the stale file is gone');
  });
});

test('firstMatching settles on the first match, or on nothing when none matches', async () => {
  const later = new Promise<number | undefined>((resolve) => setTimeout(() => resolve(8), 50));
  assert.equal(await firstMatching([Promise.resolve(1), later, Promise.resolve(undefined)], (n) => n > 5), 8);
  assert.equal(await firstMatching([Promise.resolve(1), Promise.resolve(undefined)], (n) => n > 5), undefined);
  assert.equal(await firstMatching([], () => true), undefined);
});

test("only this phone's hook sockets are picked from a runtime directory", () => {
  const udid = 'CED9FD5F-23EB-57BD-8736-5DFD6CC9EDDF';
  const files = [
    `x86sim-ax-${udid}-80.sock`,
    `x86sim-ax-${udid}-1817.sock`,
    'x86sim-ax-00000000-0000-0000-0000-000000000000-80.sock',
    `x86sim-ax-${udid}-80.sock.tmp`,
    'x86sim-a64-iphone-17-pro-simfb.ring',
  ];
  assert.deepEqual(hookSocketNames(files, udid), [`x86sim-ax-${udid}-80.sock`, `x86sim-ax-${udid}-1817.sock`]);
});

test('sim.env gives the phone identity that names the sockets', () => {
  assert.equal(
    parseSimulatorUdid('A=1\nSIMULATOR_UDID=CED9FD5F-23EB-57BD-8736-5DFD6CC9EDDF\nB=2\n'),
    'CED9FD5F-23EB-57BD-8736-5DFD6CC9EDDF',
  );
  assert.throws(() => parseSimulatorUdid('SIMULATOR_DEVICE_NAME=iPhone\n'), /SIMULATOR_UDID/);
});

/** A node with fields the type forbids, as a faulty hook could send them. */
const faulty = (overrides: Record<string, unknown>): AxNode => ({ ...button('x'), ...overrides }) as AxNode;

const wire = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ pid: 1817, bundleId: 'com.apple.Preferences', root: application(button('General')), ...overrides });

test('a well-formed reply parses to the AxNode shape', () => {
  const parsed = parseHookReply(wire());
  assert.equal(parsed.pid, 1817);
  assert.equal(parsed.bundleId, 'com.apple.Preferences');
  assert.equal(parsed.front, undefined);
  assert.equal(parsed.root.children[0]?.children[0]?.label, 'General');
});

test("SpringBoard's front app parses, and null means the home screen", () => {
  assert.deepEqual(parseHookReply(wire({ front: { pid: 7, bundleId: 'com.apple.Preferences', extra: 1 } })).front, {
    pid: 7,
    bundleId: 'com.apple.Preferences',
  });
  assert.equal(parseHookReply(wire({ front: null })).front, null);
});

test('extra hook fields are dropped and empty strings survive', () => {
  const node = faulty({ label: '', name: '', traits: 1, class: 'UIButton' });
  const parsed = parseHookReply(wire({ root: application(node) }));
  const leaf = parsed.root.children[0]?.children[0];
  assert.deepEqual(Object.keys(leaf ?? {}).sort(), [
    'children',
    'enabled',
    'frame',
    'label',
    'name',
    'type',
    'visible',
  ]);
});

test('a malformed reply is rejected with the path of the bad field', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['not JSON', 'oops', /not JSON/],
    ['a hook error', '{"error":"unknown request"}', /unknown request/],
    ['a string pid', wire({ pid: '1' }), /pid/],
    ['no bundle id', wire({ bundleId: undefined }), /bundleId/],
    ['a front that is not an object', wire({ front: 3 }), /front/],
    ['a front without a pid', wire({ front: { bundleId: 'x' } }), /front\.pid/],
    ['a root that is not the application', wire({ root: button('x') }), /root\.type/],
    ['a node without a type prefix', wire({ root: { ...application(), type: 'Button' } }), /root\.type/],
    [
      'a frame with a missing field',
      wire({ root: application(faulty({ frame: { x: 0, y: 0, width: 1 } })) }),
      /frame\.height/,
    ],
    ['a non-numeric frame field', wire({ root: application(faulty({ frame: { ...frame, x: '0' } })) }), /frame\.x/],
    ['children that are not an array', wire({ root: { ...application(), children: {} } }), /root\.children/],
    ['a label that is not a string', wire({ root: application(faulty({ label: 3 })) }), /label/],
  ];
  for (const [name, text, pattern] of cases) assert.throws(() => parseHookReply(text), pattern, name);
});

test('a tree nested deeper than the limit is rejected', () => {
  let node: AxNode = button('leaf');
  for (let depth = 0; depth < 100; depth += 1) node = { ...button('wrapper'), children: [node] };
  assert.throws(() => parseHookReply(wire({ root: { ...application(), children: [node] } })), /deeper than/);
});
