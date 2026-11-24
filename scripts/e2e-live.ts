/**
 * Milestone 2 proof: a real agent-device daemon, started in this process with the x86sim plugin,
 * drives a real iOS simulator under x86Sim through a running x86sim-webdriver server. The
 * server runs on the Linux VM and reaches this machine through `boat forward`.
 *
 * Run `npm run build` first, then
 * `X86SIM_WEBDRIVER_ENDPOINT=http://127.0.0.1:4723 node scripts/e2e-live.ts [outDir]`.
 * The snapshot is root-only for now, so every target here is a coordinate, not a ref.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startAgentDevice } from 'agent-device';
import x86sim from '../packages/plugin/dist/index.js';

const endpoint = process.env.X86SIM_WEBDRIVER_ENDPOINT ?? 'http://127.0.0.1:4723';
const outDir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'live-out'));
/** The "General" row of Settings on the 402x874 point iPhone 17 Pro, as the first screenshot shows. */
const GENERAL_ROW = { x: 200, y: 320 };
/**
 * x86Sim shows the result of an input seconds later, because the phone is emulated, so a fixed
 * sleep is wrong. After an action the script takes screenshots until the pixels differ from the
 * last picture, then until two in a row agree.
 */
const CHANGE_TIMEOUT_MS = 40_000;
const SETTLE_TIMEOUT_MS = 20_000;

const step = (text: string) => console.log(`\n== ${text}`);

const timings: Array<[string, number]> = [];
async function timed<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } finally {
    const ms = Math.round(performance.now() - started);
    timings.push([name, ms]);
    console.log(`  ${name}: ${ms} ms`);
  }
}

await mkdir(outDir, { recursive: true });
const stateDir = await mkdtemp(path.join(tmpdir(), 'x86sim-live-'));
console.log(`endpoint ${endpoint}, state dir ${stateDir}, screenshots in ${outDir}`);
const host = await startAgentDevice({ stateDir, plugins: [x86sim({ endpoint })] });
const { client } = host;

const scope = { tenant: 'x86sim', runId: 'e2e-live', leaseBackend: 'ios-instance', leaseProvider: 'x86sim' } as const;
type Leased = typeof scope & { leaseId: string };
let leaseId: string | undefined;

let counter = 0;
async function snap(leased: Leased): Promise<Buffer> {
  const file = path.join(stateDir, `snap-${(counter += 1)}.png`);
  await client.capture.screenshot({ ...leased, path: file });
  return await readFile(file);
}

/**
 * Saves the settled screen to `outDir/name`. With `before`, it first waits for the pixels to
 * differ from it and reports how long after `actionAt` that took.
 */
async function settledShot(leased: Leased, name: string, before: Buffer | undefined, actionAt: number): Promise<Buffer> {
  let latest = await snap(leased);
  if (before) {
    while (latest.equals(before) && performance.now() - actionAt < CHANGE_TIMEOUT_MS) latest = await snap(leased);
    const ms = Math.round(performance.now() - actionAt);
    timings.push([`action to changed pixels, ${name}`, ms]);
    console.log(`  ${latest.equals(before) ? 'NO CHANGE' : 'pixels changed'} ${ms} ms after the action`);
  }
  const settleBy = performance.now() + SETTLE_TIMEOUT_MS;
  for (let next = await snap(leased); !next.equals(latest) && performance.now() < settleBy; next = await snap(leased)) {
    latest = next;
  }
  const file = path.join(outDir, name);
  await writeFile(file, latest);
  console.log(`  saved ${file} (${latest.length} bytes)`);
  return latest;
}

try {
  step('allocate a lease on provider x86sim');
  const lease = await client.leases.allocate({ ...scope, platform: 'ios', device: 'x86Sim iPhone' });
  leaseId = lease.leaseId;
  console.log(`lease ${lease.leaseId} backend ${lease.backend} provider ${lease.leaseProvider}`);
  const leased: Leased = { ...scope, leaseId };

  step('open com.apple.Preferences');
  const openedAt = performance.now();
  const opened = await timed('open', () => client.apps.open({ ...leased, app: 'com.apple.Preferences' }));
  console.log(`opened ${opened.appBundleId} on ${opened.device?.name}`);

  step('screenshot 1, Settings');
  let screen = await settledShot(leased, '1-settings.png', undefined, openedAt);
  await timed('screenshot round trip', () => snap(leased));

  step(`press General at (${GENERAL_ROW.x}, ${GENERAL_ROW.y})`);
  const pressedAt = performance.now();
  const pressed = await timed('press', () => client.interactions.press({ ...leased, ...GENERAL_ROW }));
  console.log(`pressed ${JSON.stringify(pressed)}`);

  step('screenshot 2, after the tap');
  screen = await settledShot(leased, '2-after-tap.png', screen, pressedAt);

  step('home');
  const homeAt = performance.now();
  const home = await timed('home', () => client.command.home({ ...leased }));
  console.log(`home ${JSON.stringify(home)}`);

  step('screenshot 3, after home');
  await settledShot(leased, '3-after-home.png', screen, homeAt);

  step('close the session');
  console.log(`closed ${JSON.stringify(await client.sessions.close({ ...leased }))}`);

  step('timings');
  for (const [name, ms] of timings) console.log(`  ${name.padEnd(46)} ${ms} ms`);
  console.log('\nLIVE E2E PASSED');
} catch (error) {
  console.log('\nLIVE E2E FAILED');
  console.log(error);
  process.exitCode = 1;
} finally {
  if (leaseId) await client.leases.release({ ...scope, leaseId }).catch(() => undefined);
  console.log(`\nhost.close ${JSON.stringify(await host.close())}`);
  await rm(stateDir, { recursive: true, force: true });
}
