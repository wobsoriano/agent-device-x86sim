/**
 * Milestone 1 proof: a real agent-device daemon, started in this process with the x86sim
 * plugin, drives the fake WebDriver server through open, snapshot, press and close. The fake
 * server's own log then shows the touch that landed.
 *
 * Run it with `vp run e2e`, which builds the plugin first.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startAgentDevice } from 'agent-device';
import x86sim from 'agent-device-x86sim/agent-device';

type FakeCall = {
  seq: number;
  call: string;
  args: { events?: Array<{ kind: string; at?: { x: number; y: number } }> };
};

const root = path.resolve(import.meta.dirname, '..');
const requestLog: string[] = [];

function startServer(): Promise<{ child: ChildProcess; endpoint: string }> {
  const child = spawn(
    process.execPath,
    [path.join(root, 'packages/server/src/main.ts'), '--backend', 'fake', '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    for (const line of text.split('\n')) if (line) requestLog.push(line);
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      const found = /listening on (http:\/\/\S+)/.exec(text);
      if (found?.[1]) resolve({ child, endpoint: found[1] });
    });
  });
}

const step = (text: string) => console.log(`\n== ${text}`);

const { child, endpoint } = await startServer();
const stateDir = await mkdtemp(path.join(tmpdir(), 'x86sim-e2e-'));
console.log(`server ${endpoint}, state dir ${stateDir}`);
const host = await startAgentDevice({ stateDir, plugins: [x86sim({ endpoint })] });
const { client } = host;

const scope = {
  tenant: 'x86sim',
  runId: 'e2e',
  leaseBackend: 'ios-instance',
  leaseProvider: 'x86sim',
} as const;
let leaseId: string | undefined;

try {
  step('the built CLI prints the packaged hook path');
  const hookPath = spawnSync(process.execPath, [path.join(root, 'packages/plugin/dist/cli.js'), 'hook-path'], {
    encoding: 'utf8',
  });
  assert.equal(hookPath.status, 0, hookPath.stderr);
  const hook = hookPath.stdout.trim();
  assert.ok(path.isAbsolute(hook) && existsSync(hook), `hook-path printed ${hook}`);
  console.log(hook);

  step('allocate a lease on provider x86sim');
  const lease = await client.leases.allocate({ ...scope, platform: 'ios', device: 'x86Sim iPhone' });
  leaseId = lease.leaseId;
  console.log(`lease ${lease.leaseId} backend ${lease.backend} provider ${lease.leaseProvider}`);
  const leased = { ...scope, leaseId };

  step('open an app');
  const opened = await client.apps.open({ ...leased, app: 'com.example.fake' });
  console.log(`opened ${opened.appBundleId} on ${opened.device?.name} (${opened.selection?.reason})`);

  step('interactive snapshot');
  const snapshot = await client.capture.snapshot({ ...leased, interactiveOnly: true });
  for (const node of snapshot.nodes) {
    console.log(
      `  ${node.ref ?? '-'} ${node.type} label=${JSON.stringify(node.label)} rect=${JSON.stringify(node.rect)}`,
    );
  }
  const button = snapshot.nodes.find((node) => node.label === 'Continue');
  assert.ok(button, 'snapshot lists the Continue button');
  assert.ok(button.ref, 'the Continue button has a ref');
  assert.ok(button.rect, 'the Continue button has a rect');

  step('press Continue');
  // Snapshot nodes carry `e4`, but a ref target is addressed as `@e4`.
  const pressed = await client.interactions.press({ ...leased, ref: `@${button.ref}` });
  console.log(`pressed ${JSON.stringify(pressed)}`);

  step('read the fake backend log');
  const log = (await (await fetch(`${endpoint}/__fake/log`)).json()) as { calls: FakeCall[] };
  const touch = log.calls.find((entry) => entry.call === 'touch');
  assert.ok(touch, 'a touch reached the backend');
  const events = touch.args.events ?? [];
  console.log(`  touch events ${JSON.stringify(events)}`);
  const down = events.find((event) => event.kind === 'down');
  const up = events.find((event) => event.kind === 'up');
  assert.ok(down?.at && up?.at, 'the touch has a down and an up');
  const frame = { x: 24, y: 700, width: 160, height: 48 };
  for (const point of [down.at, up.at]) {
    assert.ok(
      point.x >= frame.x && point.x <= frame.x + frame.width && point.y >= frame.y && point.y <= frame.y + frame.height,
      `touch ${JSON.stringify(point)} lies inside the button frame ${JSON.stringify(frame)}`,
    );
  }
  console.log(`  down ${JSON.stringify(down.at)} and up ${JSON.stringify(up.at)} are inside ${JSON.stringify(frame)}`);

  step('probe other operations (reported, not asserted)');
  const probes: Array<[string, () => Promise<unknown>]> = [
    ['screenshot', () => client.capture.screenshot({ ...leased, path: path.join(stateDir, 'shot.png') })],
    ['swipe', () => client.interactions.swipe({ ...leased, from: { x: 200, y: 600 }, to: { x: 200, y: 200 } })],
    ['longPress', () => client.interactions.longPress({ ...leased, x: 100, y: 100 })],
    ['scroll down', () => client.interactions.scroll({ ...leased, direction: 'down' })],
    ['home', () => client.command.home({ ...leased })],
    ['type', () => client.interactions.type({ ...leased, text: 'hi' })],
    ['fill (marked unsupported)', () => client.interactions.fill({ ...leased, ref: '@e3', text: 'a@b.c' })],
    ['back (marked unsupported)', () => client.command.back({ ...leased })],
    [
      'orientation (marked unsupported)',
      () => client.command.orientation({ ...leased, orientation: 'landscape-left' }),
    ],
  ];
  for (const [name, run] of probes) {
    try {
      await run();
      console.log(`  ok      ${name}`);
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      console.log(`  failed  ${name}: [${failure.code}] ${failure.message}`);
    }
  }

  const afterProbes = (await (await fetch(`${endpoint}/__fake/log`)).json()) as { calls: FakeCall[] };
  for (const call of afterProbes.calls.filter((entry) => entry.call !== 'accessibilityTree')) {
    const kinds = (call.args.events ?? []).map((event) => event.kind);
    const counts = kinds.reduce<Record<string, number>>((all, kind) => ({ ...all, [kind]: (all[kind] ?? 0) + 1 }), {});
    console.log(
      `  backend #${call.seq} ${call.call} ${kinds.length > 0 ? JSON.stringify(counts) : JSON.stringify(call.args)}`,
    );
  }

  step('close the session');
  const closed = await client.sessions.close({ ...leased });
  console.log(`closed ${JSON.stringify(closed)}`);
  console.log('\nE2E PASSED');
} catch (error) {
  console.log('\nE2E FAILED');
  console.log(error);
  process.exitCode = 1;
} finally {
  if (leaseId) await client.leases.release({ ...scope, leaseId }).catch(() => undefined);
  console.log(`\nhost.close ${JSON.stringify(await host.close())}`);
  child.kill('SIGTERM');
  await once(child, 'close');
  await rm(stateDir, { recursive: true, force: true });

  console.log('\n== server request log (stderr)');
  for (const line of requestLog) console.log(`  ${line}`);
  console.log("\n== distinct routes agent-device called (this script's own /__fake reads left out)");
  const routes = new Set(
    requestLog
      .filter((line) => !line.includes(' /__fake/'))
      .map((line) => /^(\S+) (\S+)/.exec(line))
      .flatMap((found) =>
        found ? [`${found[1]} ${found[2]!.replace(/\/session\/[0-9a-f-]{36}/, '/session/:id')}`] : [],
      ),
  );
  for (const route of routes) console.log(`  ${route}`);
}
