import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, test } from 'vite-plus/test';
import { appArchive } from '../src/app-archive.ts';
import { FakeBackend } from '../src/backends/fake.ts';
import { createServer } from '../src/server.ts';
import { writeZip } from '../src/zip.ts';

type Seen = { mode: number; executable: string; link: string; plist: string };

/** Looks at the app the way x86Sim would, while the install runs. */
class InspectingBackend extends FakeBackend {
  seen: Seen | undefined;
  override async installApp(appPath: string): Promise<void> {
    await super.installApp(appPath);
    this.seen = {
      mode: (await lstat(path.join(appPath, 'Hello'))).mode & 0o777,
      executable: await readFile(path.join(appPath, 'Hello'), 'utf8'),
      link: await readlink(path.join(appPath, 'Current')),
      plist: await readFile(path.join(appPath, 'Info.plist'), 'utf8'),
    };
  }
}

let scratch = '';
let uploadDir = '';
let appDir = '';
let base = '';
const backend = new InspectingBackend();
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'app-upload-test-'));
  uploadDir = path.join(scratch, 'uploads');
  appDir = path.join(scratch, 'Hello.app');
  await mkdir(path.join(appDir, 'Frameworks'), { recursive: true });
  await writeFile(path.join(appDir, 'Hello'), 'binary', { mode: 0o755 });
  await writeFile(path.join(appDir, 'Info.plist'), '<plist/>', { mode: 0o644 });
  await symlink('Frameworks', path.join(appDir, 'Current'));
  server = createServer({ backend, uploadDir, log: () => undefined });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(scratch, { recursive: true, force: true });
});

const upload = async (zip: Buffer) => {
  const response = await fetch(`${base}/x86sim/apps`, { method: 'POST', body: new Uint8Array(zip) });
  return { status: response.status, json: (await response.json()) as any };
};

async function install(appPath: string) {
  const created = await fetch(`${base}/session`, { method: 'POST', body: JSON.stringify({ capabilities: {} }) });
  const sessionId = ((await created.json()) as any).value.sessionId as string;
  const installed = await fetch(`${base}/session/${sessionId}/appium/device/install_app`, {
    method: 'POST',
    body: JSON.stringify({ appPath }),
  });
  await fetch(`${base}/session/${sessionId}`, { method: 'DELETE' });
  return installed.status;
}

test('an uploaded .app installs with its modes and links, and its staged copy is removed after', async () => {
  const uploaded = await upload(await appArchive(appDir));
  assert.equal(uploaded.status, 200);
  const staged: string = uploaded.json.value.appPath;
  assert.equal(path.basename(staged), 'Hello.app');
  assert.ok(staged.startsWith(uploadDir));

  assert.equal(await install(staged), 200);
  assert.deepEqual(backend.seen, { mode: 0o755, executable: 'binary', link: 'Frameworks', plist: '<plist/>' });
  assert.equal(existsSync(staged), false);
});

test('a .zip is sent as it is', async () => {
  const zip = await appArchive(appDir);
  const zipPath = path.join(scratch, 'Hello.app.zip');
  await writeFile(zipPath, zip);
  assert.deepEqual(await appArchive(zipPath), zip);
});

test('Finder metadata in a zip made on a Mac is left out', async () => {
  const zip = writeZip([
    { kind: 'directory', path: 'Hello.app', mode: 0o755 },
    { kind: 'file', path: 'Hello.app/Info.plist', mode: 0o644, data: Buffer.from('<plist/>') },
    { kind: 'file', path: '__MACOSX/Hello.app/._Info.plist', mode: 0o644, data: Buffer.from('x') },
    { kind: 'file', path: 'Hello.app/._Info.plist', mode: 0o644, data: Buffer.from('x') },
  ]);
  const uploaded = await upload(zip);
  assert.equal(uploaded.status, 200);
  const staged: string = uploaded.json.value.appPath;
  assert.equal(existsSync(path.join(staged, '._Info.plist')), false);
  assert.equal(existsSync(path.join(path.dirname(staged), '__MACOSX')), false);
});

test('uploads that would write outside their folder, or hold no single app, are refused', async () => {
  const cases: [string, Buffer][] = [
    ['outside its folder', writeZip([{ kind: 'file', path: '../evil', mode: 0o644, data: Buffer.from('x') }])],
    [
      'points outside its folder',
      writeZip([
        { kind: 'directory', path: 'Hello.app', mode: 0o755 },
        { kind: 'symlink', path: 'Hello.app/escape', target: '../../..' },
      ]),
    ],
    ['one .app folder', writeZip([{ kind: 'file', path: 'readme.txt', mode: 0o644, data: Buffer.from('x') }])],
    ['not a zip', Buffer.from('hello')],
  ];
  for (const [message, zip] of cases) {
    const uploaded = await upload(zip);
    assert.equal(uploaded.status, 400, message);
    assert.equal(uploaded.json.value.error, 'invalid argument');
    assert.match(uploaded.json.value.message, new RegExp(message));
  }
  assert.equal(existsSync(path.join(scratch, 'evil')), false);
});

test('a server that made its own upload folder removes it when it closes', async () => {
  const own = createServer({ backend: new FakeBackend(), log: () => undefined });
  await new Promise<void>((resolve) => own.listen(0, '127.0.0.1', resolve));
  const port = (own.address() as AddressInfo).port;
  const uploaded = await fetch(`http://127.0.0.1:${port}/x86sim/apps`, {
    method: 'POST',
    body: new Uint8Array(await appArchive(appDir)),
  });
  const staged: string = ((await uploaded.json()) as any).value.appPath;
  const root = path.dirname(path.dirname(staged));
  assert.equal(existsSync(root), true);
  await new Promise<void>((resolve) => own.close(() => resolve()));
  assert.equal(existsSync(root), false);
});

test('anything other than a .app folder or a .zip is refused before it is sent', async () => {
  await assert.rejects(appArchive(path.join(appDir, 'Info.plist')), /\.app folder, or a \.zip/);
});
