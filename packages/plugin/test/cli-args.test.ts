import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { UsageError, parseCli } from '../src/cli/args.ts';

test('serve takes its defaults when no option is given', () => {
  assert.deepEqual(parseCli(['serve']), {
    kind: 'serve',
    options: { host: '127.0.0.1', port: 4723, verbose: false },
  });
});

test('serve reads every option', () => {
  const command = parseCli([
    'serve',
    '--appimage',
    '/a/x86sim.AppImage',
    '--device',
    'device-a64-iphone-17-pro',
    '--port',
    '5000',
    '--host',
    '0.0.0.0',
    '--verbose',
  ]);
  assert.deepEqual(command, {
    kind: 'serve',
    options: {
      appimage: '/a/x86sim.AppImage',
      device: 'device-a64-iphone-17-pro',
      port: 5000,
      host: '0.0.0.0',
      verbose: true,
    },
  });
});

test('hook-path, help and no arguments are their own commands', () => {
  assert.deepEqual(parseCli(['hook-path']), { kind: 'hook-path' });
  assert.deepEqual(parseCli([]), { kind: 'help' });
  assert.deepEqual(parseCli(['--help']), { kind: 'help' });
  assert.deepEqual(parseCli(['serve', '-h']), { kind: 'help' });
});

test('a port that is not a number from 0 to 65535 is a usage error', () => {
  for (const port of ['abc', '-1', '1.5', '70000', '']) {
    assert.throws(() => parseCli(['serve', '--port', port]), UsageError, port);
  }
  assert.deepEqual(parseCli(['serve', '--port', '0']), {
    kind: 'serve',
    options: { host: '127.0.0.1', port: 0, verbose: false },
  });
});

test('an unknown command, option or extra argument is a usage error', () => {
  assert.throws(() => parseCli(['start']), /Unknown command "start"/);
  assert.throws(() => parseCli(['serve', '--nope']), UsageError);
  assert.throws(() => parseCli(['serve', 'extra']), /Unexpected argument "extra"/);
  assert.throws(() => parseCli(['serve', '--port']), UsageError);
});
