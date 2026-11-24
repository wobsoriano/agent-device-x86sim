import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { PLAN, phaseOf, preparePhone } from '../src/cli/phone.ts';
import type { Action, PhoneControl, PhoneState } from '../src/cli/phone.ts';

test('a phone is ready only when it runs, answers on the hook and has accessibility on', () => {
  assert.equal(phaseOf({ running: true, hooked: true, axPrefs: true }), 'ready');
  assert.equal(phaseOf({ running: true, hooked: false, axPrefs: true }), 'stale');
  assert.equal(phaseOf({ running: true, hooked: true, axPrefs: false }), 'stale');
  assert.equal(phaseOf({ running: true, hooked: false, axPrefs: false }), 'stale');
  assert.equal(phaseOf({ running: false, hooked: false, axPrefs: false }), 'stopped');
  assert.equal(phaseOf({ running: false, hooked: false, axPrefs: true }), 'stopped');
});

/**
 * A phone that obeys the actions. `boot` loads the hook unless `deaf` says the hook never answers.
 */
function fakePhone(start: PhoneState, options: { deaf?: boolean } = {}) {
  const state = { ...start };
  const performed: Action[] = [];
  const control: PhoneControl = {
    observe: async () => ({ ...state }),
    perform: async (action) => {
      performed.push(action);
      if (action === 'stop') Object.assign(state, { running: false, hooked: false });
      if (action === 'write-prefs') state.axPrefs = true;
      if (action === 'boot') Object.assign(state, { running: true, hooked: !options.deaf });
    },
  };
  return { control, performed, state };
}

const run = async (start: PhoneState, options?: { deaf?: boolean }) => {
  const phone = fakePhone(start, options);
  const lines: string[] = [];
  await preparePhone(phone.control, (line) => lines.push(line));
  return { ...phone, lines };
};

const BOOT: Action[] = ['write-prefs', 'boot', 'wait-home', 'wait-hook'];

test('a phone that is already hooked is left alone', async () => {
  const { performed, lines } = await run({ running: true, hooked: true, axPrefs: true });
  assert.deepEqual(performed, []);
  assert.match(lines.join('\n'), /already running with the hook loaded/);
});

test('a stopped phone gets its preferences, then boots with the hook', async () => {
  const { performed, state } = await run({ running: false, hooked: false, axPrefs: false });
  assert.deepEqual(performed, BOOT);
  assert.deepEqual(state, { running: true, hooked: true, axPrefs: true });
});

test('a running phone without the hook is stopped first, then booted', async () => {
  const { performed, lines } = await run({ running: true, hooked: false, axPrefs: true });
  assert.deepEqual(performed, ['stop', ...BOOT]);
  assert.match(lines.join('\n'), /Restarting the phone to load the accessibility hook/);
});

test('a running phone with the hook but without accessibility is restarted', async () => {
  const { performed, lines } = await run({ running: true, hooked: true, axPrefs: false });
  assert.deepEqual(performed, ['stop', ...BOOT]);
  assert.match(lines.join('\n'), /Restarting the phone to turn on accessibility/);
});

test('preparing a phone twice does the work once', async () => {
  const phone = fakePhone({ running: false, hooked: false, axPrefs: false });
  await preparePhone(phone.control, () => {});
  const afterFirst = phone.performed.length;
  await preparePhone(phone.control, () => {});
  assert.equal(phone.performed.length, afterFirst);
});

test('a phone that stays unready after the rounds fails with what was last seen', async () => {
  await assert.rejects(run({ running: false, hooked: false, axPrefs: false }, { deaf: true }), (error: Error) => {
    assert.match(error.message, /not ready after 3 attempts/);
    assert.match(error.message, /"hooked":false/);
    return true;
  });
});

test('every phase but ready lists the actions that lead out of it', () => {
  assert.deepEqual(PLAN.ready, []);
  assert.deepEqual(PLAN.stale, ['stop']);
  assert.deepEqual(PLAN.stopped, BOOT);
});
