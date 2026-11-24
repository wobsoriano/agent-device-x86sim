/**
 * Live proof: a real agent-device daemon, started in this process with the x86sim plugin, drives a
 * real iOS simulator under x86Sim through a running x86sim-webdriver server. The server runs on
 * the Linux VM and reaches this machine through `boat forward`. The phone must have been booted
 * with the accessibility hook (see the README), because every target here is an `@eN` ref taken
 * from `snapshot -i`, never a coordinate.
 *
 * Run `npm run build` first, then
 * `X86SIM_WEBDRIVER_ENDPOINT=http://127.0.0.1:4723 node scripts/e2e-live.ts [outDir]`.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startAgentDevice } from 'agent-device';
import x86sim from '../packages/plugin/dist/index.js';

const endpoint = process.env.X86SIM_WEBDRIVER_ENDPOINT ?? 'http://127.0.0.1:4723';
const outDir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'live-out'));
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

/** What `snapshot -i` returns for one element, as far as this script reads it. */
type Listed = { ref?: string; type: string; label?: string; rect?: { x: number; y: number; width: number; height: number } };

const LIST_TIMEOUT_MS = 90_000;

/**
 * Takes interactive snapshots until one lists an element labelled `label` and, when `absent` is
 * given, none labelled that. A launch or a navigation animates for seconds before the new
 * screen's elements exist, and the old screen answers until then. Prints the list it settled on.
 */
async function snapshotWith(leased: Leased, label: string, absent?: string): Promise<{ nodes: Listed[]; node: Listed; ms: number }> {
  const startedAt = performance.now();
  for (;;) {
    const taken = performance.now();
    const snapshot = await client.capture.snapshot({ ...leased, interactiveOnly: true });
    const ms = Math.round(performance.now() - taken);
    const nodes = snapshot.nodes as Listed[];
    const node = nodes.find((candidate) => candidate.label === label && candidate.ref);
    if (node && !(absent && nodes.some((candidate) => candidate.label === absent))) {
      timings.push([`snapshot -i listing "${label}"`, ms]);
      console.log(`  snapshot -i: ${nodes.length} elements in ${ms} ms, ${Math.round(performance.now() - startedAt)} ms after asking`);
      for (const listed of nodes) {
        const rect = listed.rect ? `${listed.rect.x},${listed.rect.y} ${listed.rect.width}x${listed.rect.height}` : '-';
        console.log(`    @${listed.ref ?? '-'} ${listed.type} ${JSON.stringify(listed.label ?? '')} [${rect}]`);
      }
      return { nodes, node, ms };
    }
    assert.ok(performance.now() - startedAt < LIST_TIMEOUT_MS, `no element labelled "${label}" within ${LIST_TIMEOUT_MS} ms`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

try {
  step('allocate a lease on provider x86sim');
  const lease = await client.leases.allocate({ ...scope, platform: 'ios', device: 'x86Sim iPhone' });
  leaseId = lease.leaseId;
  console.log(`lease ${lease.leaseId} backend ${lease.backend} provider ${lease.leaseProvider}`);
  const leased: Leased = { ...scope, leaseId };

  step('open com.apple.Preferences, then go home');
  const opened = await timed('open', () => client.apps.open({ ...leased, app: 'com.apple.Preferences' }));
  console.log(`opened ${opened.appBundleId} on ${opened.device?.name}`);
  await snapshotWith(leased, 'General');
  const homeAt = performance.now();
  await timed('home', () => client.command.home({ ...leased }));

  step('snapshot -i on the home screen');
  // "Settings" is also the title inside the Settings app, where "General" is a row. The home screen has no such row.
  const home = await snapshotWith(leased, 'Settings', 'General');
  console.log(`  home screen reached ${Math.round(performance.now() - homeAt)} ms after the home press`);

  step(`press the Settings icon by ref @${home.node.ref}`);
  await timed('press Settings', () => client.interactions.press({ ...leased, ref: `@${home.node.ref}` }));

  step('snapshot -i in Settings');
  const settings = await snapshotWith(leased, 'General');
  const shotBefore = await snap(leased);

  step(`press the General row by ref @${settings.node.ref}`);
  const pressedAt = performance.now();
  await timed('press General', () => client.interactions.press({ ...leased, ref: `@${settings.node.ref}` }));

  step('snapshot -i on the General page');
  const general = await snapshotWith(leased, 'About');
  assert.equal(general.nodes.some((candidate) => candidate.label === 'Keyboard'), true, 'the General page lists Keyboard');

  step('screenshot of the General page');
  await settledShot(leased, 'general-page.png', shotBefore, pressedAt);

  step('snapshot latency, 10 round trips on the General page');
  const samples: number[] = [];
  for (let run = 0; run < 10; run += 1) {
    const taken = performance.now();
    await client.capture.snapshot({ ...leased, interactiveOnly: true });
    samples.push(Math.round(performance.now() - taken));
  }
  samples.sort((a, b) => a - b);
  console.log(`  ms sorted: ${samples.join(' ')}  median ${samples[Math.floor(samples.length / 2)]}`);

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
