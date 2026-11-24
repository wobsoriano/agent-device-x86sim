import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'vite-plus/test';
import { packagedHookPath } from '../src/cli/hook-path.ts';

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
