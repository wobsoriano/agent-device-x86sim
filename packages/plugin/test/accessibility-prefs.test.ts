import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vite-plus/test';
import { ACCESSIBILITY_PREFS_SCRIPT } from '../src/cli/accessibility-prefs.ts';

const python = (...args: string[]) =>
  execFileSync('python3', ['-I', '-c', ACCESSIBILITY_PREFS_SCRIPT, ...args], { encoding: 'utf8' }).trim();

/** Reads a property list back as JSON through the same Python library the script uses. */
const readPrefs = (file: string): unknown =>
  JSON.parse(
    execFileSync(
      'python3',
      ['-I', '-c', 'import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))', file],
      { encoding: 'utf8' },
    ),
  );

async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ax-prefs-'));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a missing file is not on, and enable creates it with all three keys in a binary plist', async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, 'Library', 'Preferences', 'com.apple.Accessibility.plist');
    assert.equal(python('check', file), 'false');
    python('enable', file);
    assert.equal(python('check', file), 'true');
    assert.deepEqual(readPrefs(file), {
      ApplicationAccessibilityEnabled: true,
      AccessibilityEnabled: true,
      AutomationEnabled: true,
    });
    assert.equal((await readFile(file)).subarray(0, 8).toString(), 'bplist00');
  });
});

test('enable keeps the keys that were there and leaves no temporary file', async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, 'prefs.plist');
    await writeFile(
      file,
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Keep</key><string>me</string><key>AccessibilityEnabled</key><false/></dict></plist>',
    );
    assert.equal(python('check', file), 'false');
    python('enable', file);
    assert.deepEqual(readPrefs(file), {
      Keep: 'me',
      ApplicationAccessibilityEnabled: true,
      AccessibilityEnabled: true,
      AutomationEnabled: true,
    });
    assert.deepEqual(await readdir(dir), ['prefs.plist']);
    assert.equal((await stat(file)).mode & 0o777, 0o644);
  });
});

test('enable on a file that is already on does not rewrite it', async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, 'prefs.plist');
    python('enable', file);
    const before = await stat(file);
    python('enable', file);
    assert.equal((await stat(file)).ino, before.ino);
  });
});

test('a file with the two older keys on is still off until automation is on too', async () => {
  await inTempDir(async (dir) => {
    const file = path.join(dir, 'prefs.plist');
    await writeFile(
      file,
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>ApplicationAccessibilityEnabled</key><true/><key>AccessibilityEnabled</key><true/></dict></plist>',
    );
    assert.equal(python('check', file), 'false');
    python('enable', file);
    assert.equal(python('check', file), 'true');
  });
});
