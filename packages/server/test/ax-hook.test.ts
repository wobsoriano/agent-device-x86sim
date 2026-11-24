import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SPRINGBOARD_BUNDLE_ID, chooseReply, hookSocketNames, parseHookReply } from '../src/backends/ax-hook.ts';
import type { HookReply } from '../src/backends/ax-hook.ts';
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

const reply = (bundleId: string, pid: number, active: boolean, root: AxNode): HookReply => ({ pid, bundleId, active, root });

test('an app in front wins over SpringBoard', () => {
  const springboard = reply(SPRINGBOARD_BUNDLE_ID, 80, true, application(button('Settings')));
  const settings = reply('com.apple.Preferences', 1817, true, application(button('General')));
  assert.equal(chooseReply([springboard, settings]), settings);
});

test('with no app active the home screen is SpringBoard', () => {
  const springboard = reply(SPRINGBOARD_BUNDLE_ID, 80, true, application(button('Settings')));
  const settings = reply('com.apple.Preferences', 1817, false, application(button('General')));
  assert.equal(chooseReply([settings, springboard]), springboard);
});

test('the keyboard process and a process with no window are not the app in front', () => {
  const springboard = reply(SPRINGBOARD_BUNDLE_ID, 80, true, application(button('Settings')));
  const keyboard = reply('com.apple.InputUI', 900, true, application(button('a')));
  const windowless = reply('com.apple.mobilesafari', 901, true, application());
  assert.equal(chooseReply([keyboard, windowless, springboard]), springboard);
});

test('among several active apps the newest process wins, in any order', () => {
  const older = reply('com.example.a', 100, true, application(button('Old')));
  const newer = reply('com.example.b', 200, true, application(button('New')));
  assert.equal(chooseReply([newer, older]), newer);
  assert.equal(chooseReply([older, newer]), newer);
});

test('nothing active means no answer', () => {
  assert.equal(chooseReply([]), undefined);
  assert.equal(chooseReply([reply('com.apple.Preferences', 1, false, application(button('General')))]), undefined);
});

test('only this phone\'s hook sockets are picked from a runtime directory', () => {
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
  assert.equal(parseSimulatorUdid('A=1\nSIMULATOR_UDID=CED9FD5F-23EB-57BD-8736-5DFD6CC9EDDF\nB=2\n'), 'CED9FD5F-23EB-57BD-8736-5DFD6CC9EDDF');
  assert.throws(() => parseSimulatorUdid('SIMULATOR_DEVICE_NAME=iPhone\n'), /SIMULATOR_UDID/);
});

/** A node with fields the type forbids, as a faulty hook could send them. */
const faulty = (overrides: Record<string, unknown>): AxNode => ({ ...button('x'), ...overrides }) as AxNode;

const wire = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ pid: 1817, bundleId: 'com.apple.Preferences', active: true, root: application(button('General')), ...overrides });

test('a well-formed reply parses to the AxNode shape', () => {
  const parsed = parseHookReply(wire());
  assert.equal(parsed.pid, 1817);
  assert.equal(parsed.bundleId, 'com.apple.Preferences');
  assert.equal(parsed.active, true);
  assert.equal(parsed.root.children[0]?.children[0]?.label, 'General');
});

test('extra hook fields are dropped and empty strings survive', () => {
  const node = faulty({ label: '', name: '', traits: 1, class: 'UIButton' });
  const parsed = parseHookReply(wire({ root: application(node) }));
  const leaf = parsed.root.children[0]?.children[0];
  assert.deepEqual(Object.keys(leaf ?? {}).sort(), ['children', 'enabled', 'frame', 'label', 'name', 'type', 'visible']);
});

test('a malformed reply is rejected with the path of the bad field', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['not JSON', 'oops', /not JSON/],
    ['a hook error', '{"error":"unknown request"}', /unknown request/],
    ['a string pid', wire({ pid: '1' }), /pid/],
    ['no bundle id', wire({ bundleId: undefined }), /bundleId/],
    ['a non-boolean active', wire({ active: 1 }), /active/],
    ['a root that is not the application', wire({ root: button('x') }), /root\.type/],
    ['a node without a type prefix', wire({ root: { ...application(), type: 'Button' } }), /root\.type/],
    ['a frame with a missing field', wire({ root: application(faulty({ frame: { x: 0, y: 0, width: 1 } })) }), /frame\.height/],
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
