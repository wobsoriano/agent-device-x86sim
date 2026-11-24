import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { MIN_TOUCH_MS, buttonSteps, edgeAt, parseSimEnv, pointSize, touchSteps } from '../src/backends/simhid.ts';
import type { SimhidStep } from '../src/backends/simhid.ts';
import type { Size, TouchEvent } from '../src/types.ts';

/** iPhone 17 Pro in points. */
const SCREEN: Size = { width: 402, height: 874 };

const lines = (steps: SimhidStep[]) => steps.flatMap((step) => (step.kind === 'line' ? [step.line] : []));
const waits = (steps: SimhidStep[]) => steps.flatMap((step) => (step.kind === 'wait' ? [step.ms] : []));

test('a tap becomes normalized down and up lines with an 80 ms hold between them', () => {
  const steps = touchSteps(
    [
      { kind: 'down', at: { x: 201, y: 437 } },
      { kind: 'up', at: { x: 201, y: 437 } },
    ],
    SCREEN,
  );
  assert.deepEqual(steps, [
    { kind: 'line', line: 'touch down 0.50000 0.50000' },
    { kind: 'wait', ms: MIN_TOUCH_MS },
    { kind: 'line', line: 'touch up 0.50000 0.50000' },
  ]);
});

test('a touch held longer than the minimum is not padded', () => {
  const steps = touchSteps(
    [
      { kind: 'down', at: { x: 100, y: 100 } },
      { kind: 'pause', ms: 600 },
      { kind: 'up', at: { x: 100, y: 100 } },
    ],
    SCREEN,
  );
  assert.deepEqual(waits(steps), [600]);
});

test('a short pause is topped up to the minimum, not added to it', () => {
  const steps = touchSteps(
    [
      { kind: 'down', at: { x: 100, y: 100 } },
      { kind: 'pause', ms: 30 },
      { kind: 'up', at: { x: 100, y: 100 } },
    ],
    SCREEN,
  );
  assert.deepEqual(waits(steps), [30, 50]);
});

test('a drag keeps its moves and pauses in order and is not padded when it is slow enough', () => {
  const events: TouchEvent[] = [
    { kind: 'down', at: { x: 201, y: 600 } },
    { kind: 'pause', ms: 50 },
    { kind: 'move', at: { x: 201, y: 500 } },
    { kind: 'pause', ms: 50 },
    { kind: 'move', at: { x: 201, y: 400 } },
    { kind: 'up', at: { x: 201, y: 400 } },
  ];
  const steps = touchSteps(events, SCREEN);
  assert.deepEqual(
    steps.map((step) => (step.kind === 'wait' ? `wait ${step.ms}` : step.line.split(' ').slice(0, 2).join(' '))),
    ['touch down', 'wait 50', 'touch move', 'wait 50', 'touch move', 'touch up'],
  );
});

test('pauses before a touch lands do not count toward its hold', () => {
  const steps = touchSteps(
    [
      { kind: 'pause', ms: 500 },
      { kind: 'down', at: { x: 10, y: 400 } },
      { kind: 'up', at: { x: 10, y: 400 } },
    ],
    SCREEN,
  );
  assert.deepEqual(waits(steps), [500, MIN_TOUCH_MS]);
});

test('points outside the display are clamped onto it', () => {
  const steps = touchSteps(
    [
      { kind: 'down', at: { x: -5, y: 900 } },
      { kind: 'up', at: { x: 500, y: -1 } },
    ],
    SCREEN,
  );
  assert.deepEqual(lines(steps), ['touch down 0.00000 1.00000 bottom', 'touch up 1.00000 0.00000']);
});

test('only the down line names an edge, and the corners go to top and bottom', () => {
  const edge = (x: number, y: number) => edgeAt({ x, y }, SCREEN);
  assert.equal(edge(201, 437), undefined);
  assert.equal(edge(201, 870), 'bottom');
  assert.equal(edge(201, 3), 'top');
  assert.equal(edge(5, 437), 'left');
  assert.equal(edge(398, 437), 'right');
  assert.equal(edge(2, 872), 'bottom');
  assert.equal(edge(2, 2), 'top');
  // The margin is 4% of the width, 16.08 points here.
  assert.equal(edge(16, 437), 'left');
  assert.equal(edge(17, 437), undefined);

  const swipeUp = touchSteps(
    [
      { kind: 'down', at: { x: 201, y: 870 } },
      { kind: 'move', at: { x: 201, y: 600 } },
      { kind: 'up', at: { x: 201, y: 600 } },
    ],
    SCREEN,
  );
  assert.deepEqual(
    lines(swipeUp).map((line) => line.endsWith('bottom')),
    [true, false, false],
  );
});

test('a hardware button is pressed, held and released', () => {
  assert.deepEqual(buttonSteps('home'), [
    { kind: 'line', line: 'button home down' },
    { kind: 'wait', ms: 100 },
    { kind: 'line', line: 'button home up' },
  ]);
  assert.deepEqual(lines(buttonSteps('volumeUp')), ['button volup down', 'button volup up']);
  assert.deepEqual(lines(buttonSteps('volumeDown')), ['button voldown down', 'button voldown up']);
  assert.deepEqual(lines(buttonSteps('lock')), ['button lock down', 'button lock up']);
});

test('sim.env gives the panel in pixels and the scale, so points are pixels over scale', () => {
  const geometry = parseSimEnv(
    [
      'HOME=/x',
      'SIMULATOR_MAINSCREEN_WIDTH=1206',
      'SIMULATOR_MAINSCREEN_HEIGHT=2622',
      'SIMULATOR_MAINSCREEN_SCALE=3.000000',
      '',
    ].join('\n'),
  );
  assert.deepEqual(geometry, { pixels: { width: 1206, height: 2622 }, scale: 3 });
  assert.deepEqual(pointSize(geometry), SCREEN);
});

test('a sim.env without the panel is an error', () => {
  assert.throws(() => parseSimEnv('HOME=/x\nSIMULATOR_MAINSCREEN_WIDTH=1206\n'), /SIMULATOR_MAINSCREEN/);
});
