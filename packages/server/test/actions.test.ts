import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { parseActions, toTouchEvents } from '../src/actions.ts';
import { WebDriverError } from '../src/errors.ts';
import type { TouchEvent, W3cActionSequence, W3cPointerAction } from '../src/types.ts';

const touch = (actions: W3cPointerAction[]): W3cActionSequence[] => [
  { type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions },
];

test('a tap is down and up at the moved-to position', () => {
  const events = toTouchEvents(
    touch([
      { type: 'pointerMove', duration: 0, x: 104, y: 724 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
    ]),
  );
  assert.deepEqual(events, [
    { kind: 'down', at: { x: 104, y: 724 } },
    { kind: 'up', at: { x: 104, y: 724 } },
  ]);
});

test('a long press keeps the pause between down and up', () => {
  const events = toTouchEvents(
    touch([
      { type: 'pointerMove', duration: 0, x: 10, y: 20 },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 600 },
      { type: 'pointerUp', button: 0 },
    ]),
  );
  assert.deepEqual(events, [
    { kind: 'down', at: { x: 10, y: 20 } },
    { kind: 'pause', ms: 600 },
    { kind: 'up', at: { x: 10, y: 20 } },
  ]);
});

test('a double tap keeps both taps and the gap', () => {
  const events = toTouchEvents(
    touch([
      { type: 'pointerMove', duration: 0, x: 5, y: 6 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
      { type: 'pause', duration: 80 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
    ]),
  );
  assert.deepEqual(
    events.map((event) => event.kind),
    ['down', 'up', 'pause', 'down', 'up'],
  );
});

test('a timed drag becomes evenly spaced moves that end exactly on the target', () => {
  const events = toTouchEvents(
    touch([
      { type: 'pointerMove', duration: 0, x: 200, y: 600 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: 400, x: 200, y: 200 },
      { type: 'pointerUp', button: 0 },
    ]),
  );
  const moves = events.filter((event) => event.kind === 'move');
  const pauses = events.filter((event) => event.kind === 'pause');
  assert.equal(moves.length, 25);
  assert.equal(pauses.length, 25);
  const total = pauses.reduce((sum, event) => sum + (event.kind === 'pause' ? event.ms : 0), 0);
  assert.ok(Math.abs(total - 400) < 1e-9);
  assert.deepEqual(moves.at(-1), { kind: 'move', at: { x: 200, y: 200 } });
  assert.deepEqual(events.at(-1), { kind: 'up', at: { x: 200, y: 200 } });
  const ys = moves.map((event) => (event.kind === 'move' ? event.at.y : NaN));
  assert.deepEqual([...ys].sort((a, b) => b - a), ys, 'y only decreases along an upward swipe');
});

test('an instant move while pressed is a single move', () => {
  const events = toTouchEvents(
    touch([
      { type: 'pointerMove', x: 1, y: 1 },
      { type: 'pointerDown' },
      { type: 'pointerMove', duration: 0, x: 50, y: 60 },
      { type: 'pointerUp' },
    ]),
  );
  assert.deepEqual(events, [
    { kind: 'down', at: { x: 1, y: 1 } },
    { kind: 'move', at: { x: 50, y: 60 } },
    { kind: 'up', at: { x: 50, y: 60 } },
  ] satisfies TouchEvent[]);
});

test('a timed move without a press waits instead of moving', () => {
  const events = toTouchEvents(touch([{ type: 'pointerMove', duration: 250, x: 9, y: 9 }]));
  assert.deepEqual(events, [{ kind: 'pause', ms: 250 }]);
});

test('key sources are ignored and an empty request yields no events', () => {
  assert.deepEqual(toTouchEvents([{ type: 'key', id: 'k', actions: [] }]), []);
  assert.deepEqual(toTouchEvents([]), []);
});

test('two pointer sequences are refused', () => {
  assert.throws(
    () => toTouchEvents([...touch([]), ...touch([])]),
    (error: unknown) => error instanceof WebDriverError && error.error === 'unsupported operation',
  );
});

test('parseActions accepts what agent-device sends', () => {
  const sequences = parseActions({
    actions: [
      {
        type: 'pointer',
        id: 'tap',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: 1, y: 2 },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  });
  assert.equal(toTouchEvents(sequences).length, 2);
});

test('parseActions rejects malformed input as invalid argument', () => {
  for (const body of [
    undefined,
    {},
    { actions: [{ type: 'pointer', id: 'a', actions: [{ type: 'pointerMove', x: 'left', y: 1 }] }] },
    { actions: [{ type: 'pointer', id: 'a', actions: [{ type: 'pointerMove', x: 1, y: 1, origin: 'pointer' }] }] },
    { actions: [{ type: 'pointer', id: 'a', actions: [{ type: 'teleport' }] }] },
    { actions: [{ type: 'hologram', id: 'a', actions: [] }] },
  ]) {
    assert.throws(
      () => parseActions(body),
      (error: unknown) => error instanceof WebDriverError && error.error === 'invalid argument',
    );
  }
});
