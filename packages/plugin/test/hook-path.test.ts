import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'vite-plus/test';
import { insertedLibraries, loadedHookIsPackaged, packagedHookPath } from '../src/cli/hook-path.ts';

test('the hook is found next to dist in the installed package, as an absolute path', async () => {
  const pkg = await mkdtemp(path.join(tmpdir(), 'pkg-'));
  try {
    await mkdir(path.join(pkg, 'dist'));
    await mkdir(path.join(pkg, 'ax-hook'));
    await writeFile(path.join(pkg, 'ax-hook', 'libx86sim-ax.dylib'), 'x');
    const found = await packagedHookPath(pathToFileURL(path.join(pkg, 'dist', 'cli.js')).href);
    assert.equal(found, path.join(pkg, 'ax-hook', 'libx86sim-ax.dylib'));
  } finally {
    await rm(pkg, { recursive: true, force: true });
  }
});

test('a package without the hook says where it looked', async () => {
  await assert.rejects(
    packagedHookPath('file:///nowhere/dist/cli.js'),
    /missing from this install, at \/nowhere\/ax-hook\/libx86sim-ax\.dylib/,
  );
});

const SYSTEM_ROOT = '/Volumes/SystemRoot';

test('the libraries a phone loaded are listed as Linux paths', () => {
  const simEnv = [
    'SIMULATOR_UDID=ABC',
    `DYLD_INSERT_LIBRARIES=${SYSTEM_ROOT}/a/libsimshim.dylib:/already/linux/lib.dylib::${SYSTEM_ROOT}/b/libx86sim-ax.dylib`,
    'HOME=/x',
  ].join('\n');
  assert.deepEqual(insertedLibraries(simEnv), [
    '/a/libsimshim.dylib',
    '/already/linux/lib.dylib',
    '/b/libx86sim-ax.dylib',
  ]);
  assert.deepEqual(insertedLibraries('HOME=/x\n'), []);
});

test('a phone counts as hooked only when the hook it loaded has the packaged bytes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hook-'));
  try {
    const packaged = path.join(dir, 'packaged.dylib');
    const same = path.join(dir, 'same.dylib');
    const older = path.join(dir, 'older.dylib');
    await writeFile(packaged, 'new hook');
    await writeFile(same, 'new hook');
    await writeFile(older, 'old hook');
    const loading = (...files: string[]) =>
      `DYLD_INSERT_LIBRARIES=${files.map((file) => SYSTEM_ROOT + file).join(':')}\n`;

    assert.equal(await loadedHookIsPackaged(loading(same), packaged), true, 'a copy with the same bytes');
    assert.equal(await loadedHookIsPackaged(loading(older, same), packaged), true, 'among other libraries');
    assert.equal(await loadedHookIsPackaged(loading(older), packaged), false, 'an older build');
    assert.equal(await loadedHookIsPackaged(loading(path.join(dir, 'gone.dylib')), packaged), false, 'a missing file');
    assert.equal(await loadedHookIsPackaged('HOME=/x\n', packaged), false, 'no hook at all');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
