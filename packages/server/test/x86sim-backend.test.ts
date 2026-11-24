import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { X86SimBackend } from '../src/backends/x86sim.ts';

/** A backend whose `x86sim` command is a shell snippet that prints to stderr and exits with `code`. */
const backendWhere = (stderr: string, code: number) =>
  new X86SimBackend({
    cli: () => ({ command: 'sh', args: ['-c', `echo '${stderr}' >&2; exit ${code}`] }),
    device: '/nowhere',
  });

test('terminating an app that is not running succeeds', async () => {
  await backendWhere('x86sim terminate: not running or termination failed', 1).terminateApp('com.apple.Preferences');
});

test('any other terminate failure still fails', async () => {
  await assert.rejects(backendWhere('no such device', 2).terminateApp('com.apple.Preferences'), /no such device/);
});

test('terminating a running app succeeds', async () => {
  await backendWhere('', 0).terminateApp('com.apple.Preferences');
});
