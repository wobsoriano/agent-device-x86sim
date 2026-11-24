import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import {
  appImageInstall,
  compareVersions,
  dataDirInstall,
  newestVersion,
  x86simCacheDir,
  x86simDataDir,
} from '../src/cli/install.ts';

test('the data folder follows X86SIM_DATA, then XDG_DATA_HOME, then ~/.local/share', () => {
  assert.equal(x86simDataDir({}, '/home/u'), '/home/u/.local/share/x86sim');
  assert.equal(x86simDataDir({ XDG_DATA_HOME: '/data' }, '/home/u'), '/data/x86sim');
  assert.equal(x86simDataDir({ XDG_DATA_HOME: '/data', X86SIM_DATA: '/mine' }, '/home/u'), '/mine');
});

test('the cache folder follows X86SIM_CACHE, then XDG_CACHE_HOME, then ~/.cache', () => {
  assert.equal(x86simCacheDir({}, '/home/u'), '/home/u/.cache/x86sim');
  assert.equal(x86simCacheDir({ XDG_CACHE_HOME: '/c' }, '/home/u'), '/c/x86sim');
  assert.equal(x86simCacheDir({ X86SIM_CACHE: '/mine' }, '/home/u'), '/mine');
});

test('versions compare part by part, and a pre-release is older than its release', () => {
  assert.equal(newestVersion(['0.9.1', '0.10.0', '0.5.3']), '0.10.0');
  assert.equal(newestVersion(['0.1.0-pre8', '0.1.0']), '0.1.0');
  assert.equal(newestVersion(['0.1.0-pre8', '0.1.0-pre10']), '0.1.0-pre10');
  assert.equal(newestVersion([]), undefined);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});

const parts = {
  dataDir: '/home/u/.local/share/x86sim',
  cacheDir: '/home/u/.cache/x86sim',
  version: '0.5.3',
  darlingId: 'abc123',
  darlingMode: 'userns',
  path: '/usr/bin',
} as const;

test('a copy in the data folder runs with the environment the AppImage exports', () => {
  const launch = dataDirInstall(parts).cli(['wait', 'home', '540']);
  assert.equal(launch.command, '/home/u/.local/share/x86sim/app/0.5.3/cli/x86sim');
  assert.deepEqual(launch.args, ['wait', 'home', '540']);
  assert.deepEqual(launch.env, {
    X86SIM_DARLING_MODE: 'userns',
    X86SIM_ROOT: '/home/u/.local/share/x86sim',
    X86SIM_SCRATCH: '/home/u/.cache/x86sim',
    X86SIM_APP: '/home/u/.local/share/x86sim/app/0.5.3',
    X86SIM_VERSION: '0.5.3',
    X86SIM_DARLING_ID: 'abc123',
    X86SIM_PYLIB: '/home/u/.local/share/x86sim/app/0.5.3/pylib',
    A64_PREFIX_HEAL: '0',
    PATH: '/home/u/.local/share/x86sim/app/0.5.3/bin:/usr/bin',
  });
});

test('the boot script runs from the data folder, where the AppImage shell would run it', () => {
  const launch = dataDirInstall(parts).boot();
  assert.deepEqual(
    [launch.command, launch.args, launch.cwd],
    ['/bin/sh', ['-c', 'cli/libexec/arm64/boot-a64.sh'], parts.dataDir],
  );
  assert.equal(launch.env.X86SIM_ROOT, parts.dataDir);
});

test('an AppImage runs everything through its own entry point', () => {
  const x86sim = appImageInstall('/dl/x86sim.AppImage', '/data/x86sim');
  assert.deepEqual(x86sim.cli(['type', 'hi']), {
    command: '/dl/x86sim.AppImage',
    args: ['x86sim', 'type', 'hi'],
    env: {},
  });
  assert.deepEqual(x86sim.boot().args, ['shell', '-c', 'cli/libexec/arm64/boot-a64.sh']);
  assert.equal(x86sim.dataDir, '/data/x86sim');
});
