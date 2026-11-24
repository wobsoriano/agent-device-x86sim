import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { PLAN, phaseOf, preparePhone } from '../src/cli/phone.ts';
import type { Action, PhoneControl, PhoneState } from '../src/cli/phone.ts';

test('a phone is ready only when it runs, loaded the packaged hook and has accessibility on', () => {
  assert.equal(phaseOf({ running: true, hook: 'current', axPrefs: true }), 'ready');
  assert.equal(phaseOf({ running: true, hook: 'none', axPrefs: true }), 'stale');
  assert.equal(phaseOf({ running: true, hook: 'current', axPrefs: false }), 'stale');
  assert.equal(phaseOf({ running: true, hook: 'none', axPrefs: false }), 'stale');
  assert.equal(phaseOf({ running: true, hook: 'outdated', axPrefs: true }), 'stale');
  assert.equal(phaseOf({ running: false, hook: 'none', axPrefs: false }), 'stopped');
  assert.equal(phaseOf({ running: false, hook: 'none', axPrefs: true }), 'stopped');
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
      if (action === 'stop') Object.assign(state, { running: false, hook: 'none' });
      if (action === 'write-prefs') state.axPrefs = true;
      if (action === 'boot') Object.assign(state, { running: true, hook: options.deaf ? 'none' : 'current' });
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
  const { performed, lines } = await run({ running: true, hook: 'current', axPrefs: true });
  assert.deepEqual(performed, []);
  assert.match(lines.join('\n'), /already running with the hook loaded/);
});

test('a stopped phone gets its preferences, then boots with the hook', async () => {
  const { performed, state } = await run({ running: false, hook: 'none', axPrefs: false });
  assert.deepEqual(performed, BOOT);
  assert.deepEqual(state, { running: true, hook: 'current', axPrefs: true });
});

test('a running phone without the hook is stopped first, then booted', async () => {
  const { performed, lines } = await run({ running: true, hook: 'none', axPrefs: true });
  assert.deepEqual(performed, ['stop', ...BOOT]);
  assert.match(lines.join('\n'), /Restarting the phone to load the accessibility hook/);
});

test('a running phone with an outdated hook is restarted and says why', async () => {
  const { performed, lines, state } = await run({ running: true, hook: 'outdated', axPrefs: true });
  assert.deepEqual(performed, ['stop', ...BOOT]);
  assert.match(lines.join('\n'), /Restarting the phone to load the updated accessibility hook\./);
  assert.equal(state.hook, 'current');
});

test('an outdated hook and missing preferences are fixed in one restart', async () => {
  const { performed, lines } = await run({ running: true, hook: 'outdated', axPrefs: false });
  assert.deepEqual(performed, ['stop', ...BOOT]);
  assert.match(lines.join('\n'), /load the updated accessibility hook and turn on accessibility/);
});

test('a running phone with the hook but without accessibility is restarted', async () => {
  const { performed, lines } = await run({ running: true, hook: 'current', axPrefs: false });
  assert.deepEqual(performed, ['stop', ...BOOT]);
  assert.match(lines.join('\n'), /Restarting the phone to turn on accessibility/);
});

test('preparing a phone twice does the work once', async () => {
  const phone = fakePhone({ running: false, hook: 'none', axPrefs: false });
  await preparePhone(phone.control, () => {});
  const afterFirst = phone.performed.length;
  await preparePhone(phone.control, () => {});
  assert.equal(phone.performed.length, afterFirst);
});

test('a phone that stays unready after the rounds fails with what was last seen', async () => {
  await assert.rejects(run({ running: false, hook: 'none', axPrefs: false }, { deaf: true }), (error: Error) => {
    assert.match(error.message, /not ready after 3 attempts/);
    assert.match(error.message, /"hook":"none"/);
    return true;
  });
});

test('every phase but ready lists the actions that lead out of it', () => {
  assert.deepEqual(PLAN.ready, []);
  assert.deepEqual(PLAN.stale, ['stop']);
  assert.deepEqual(PLAN.stopped, BOOT);
});
