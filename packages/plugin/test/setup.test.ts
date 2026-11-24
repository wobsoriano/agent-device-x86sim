import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { readCheck, runSetup, sumFor } from '../src/cli/setup.ts';
import type { SetupStep } from '../src/cli/setup.ts';

/** A step over one flag of a pretend machine. `works: false` runs without setting the flag. */
function step(machine: Set<string>, part: string, ran: string[], works = true): SetupStep {
  return {
    doing: `make ${part}`,
    already: `${part} is there`,
    isDone: async () => machine.has(part),
    run: async () => {
      ran.push(part);
      if (works) machine.add(part);
    },
  };
}

test('setup runs only the steps that are not done, in order', async () => {
  const machine = new Set(['x86sim']);
  const ran: string[] = [];
  const log: string[] = [];
  await runSetup(
    ['x86sim', 'runtime', 'phone'].map((part) => step(machine, part, ran)),
    (line) => log.push(line),
  );
  assert.deepEqual(ran, ['runtime', 'phone']);
  assert.deepEqual(log, ['x86sim is there', 'make runtime', 'make phone']);
});

test('a second setup changes nothing', async () => {
  const machine = new Set<string>();
  const ran: string[] = [];
  const steps = ['x86sim', 'runtime'].map((part) => step(machine, part, ran));
  await runSetup(steps, () => {});
  await runSetup(steps, () => {});
  assert.deepEqual(ran, ['x86sim', 'runtime']);
});

test('a step that runs but leaves its part missing stops the setup', async () => {
  const machine = new Set<string>();
  const ran: string[] = [];
  await assert.rejects(
    runSetup([step(machine, 'runtime', ran, false), step(machine, 'phone', ran)], () => {}),
    /finished, but its result is missing: make runtime/,
  );
  assert.deepEqual(ran, ['runtime']);
});

test('a step without a check runs every time', async () => {
  let runs = 0;
  const check: SetupStep = { doing: 'check', run: async () => void (runs += 1) };
  await runSetup([check], () => {});
  await runSetup([check], () => {});
  assert.equal(runs, 2);
});

test("the AppImage's sum is read from the release's SHA256SUMS", () => {
  const sums = ['aa11  x86sim-0.5.3-x86_64.AppImage.zsync', 'BB22 *x86sim-0.5.3-x86_64.AppImage', ''].join('\n');
  assert.equal(sumFor(sums, 'x86sim-0.5.3-x86_64.AppImage'), 'bb22');
  assert.equal(sumFor(sums, 'x86sim-0.5.2-x86_64.AppImage'), undefined);
});

test("x86Sim's check tells whether Darling is ready and whether setup is needed", () => {
  const ready = [
    'x86Sim 0.5.3 · data /home/u/.local/share/x86sim',
    'warn  Memory               12 GB',
    'ok    Darling              runs without root (user namespace)',
    'setup needed: false',
  ].join('\n');
  assert.deepEqual(readCheck(ready), { darlingOk: true, setupNeeded: false });
  const fresh = ['fail  Darling              needs to be installed', 'setup needed: true'].join('\n');
  assert.deepEqual(readCheck(fresh), { darlingOk: false, setupNeeded: true });
});
