import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { findAppImage, findDevice, newestAppImage, x86simDataDir } from '../src/cli/discovery.ts';
import type { Environment } from '../src/cli/discovery.ts';

/** A machine whose folders hold the given names, and whose executables are the given files. */
function machine(
  folders: Record<string, string[]>,
  options: { env?: Record<string, string>; executable?: string[] } = {},
): Environment {
  return {
    env: options.env ?? {},
    home: '/home/u',
    cwd: '/work',
    listDir: async (dir) => folders[dir] ?? [],
    isExecutable: async (file) => (options.executable ? options.executable.includes(file) : true),
  };
}

test('the newest AppImage wins by version number, not by name order', async () => {
  const found = await newestAppImage(['/home/u/x86sim', '/home/u/Downloads'], async (dir) =>
    dir === '/home/u/x86sim'
      ? ['x86sim-0.9.1-x86_64.AppImage', 'notes.txt']
      : ['x86sim-0.10.0-x86_64.AppImage', 'x86sim-0.5.3-x86_64.AppImage'],
  );
  assert.equal(found, '/home/u/Downloads/x86sim-0.10.0-x86_64.AppImage');
});

test('with the same version in two folders, the earlier folder wins', async () => {
  const found = await newestAppImage(['/a', '/b'], async () => ['x86sim-0.5.3-x86_64.AppImage']);
  assert.equal(found, '/a/x86sim-0.5.3-x86_64.AppImage');
});

test('files that are not x86Sim AppImages are ignored', async () => {
  const found = await newestAppImage(['/a'], async () => [
    'x86sim-0.5.3-x86_64.AppImage.zsync',
    'x86sim.AppImage',
    'other-1.0-x86_64.AppImage',
  ]);
  assert.equal(found, undefined);
});

test('--appimage wins over the environment, and the environment wins over the folders', async () => {
  const environment = machine(
    { '/home/u/x86sim': ['x86sim-0.5.3-x86_64.AppImage'] },
    { env: { X86SIM_APPIMAGE: '/env/x86sim.AppImage' } },
  );
  assert.equal(await findAppImage('/flag/x86sim.AppImage', environment), '/flag/x86sim.AppImage');
  assert.equal(await findAppImage(undefined, environment), '/env/x86sim.AppImage');
  assert.equal(
    await findAppImage(undefined, machine({ '/home/u/x86sim': ['x86sim-0.5.3-x86_64.AppImage'] })),
    '/home/u/x86sim/x86sim-0.5.3-x86_64.AppImage',
  );
});

test('a relative --appimage is read from the current folder', async () => {
  assert.equal(await findAppImage('./x86sim.AppImage', machine({ '/work': [] })), '/work/x86sim.AppImage');
});

test('no AppImage names every folder it looked in and where to download one', async () => {
  await assert.rejects(findAppImage(undefined, machine({})), (error: Error) => {
    for (const folder of ['/home/u/x86sim', '/home/u/Applications', '/home/u/Downloads', '/work']) {
      assert.match(error.message, new RegExp(folder));
    }
    assert.match(error.message, /github\.com\/x86sim\/x86sim\/releases/);
    assert.match(error.message, /--appimage/);
    return true;
  });
});

test('an AppImage that is not executable says to chmod it', async () => {
  const environment = machine({ '/home/u/x86sim': ['x86sim-0.5.3-x86_64.AppImage'] }, { executable: [] });
  await assert.rejects(
    findAppImage(undefined, environment),
    /chmod \+x \/home\/u\/x86sim\/x86sim-0\.5\.3-x86_64\.AppImage/,
  );
});

test('the data folder follows XDG_DATA_HOME, else ~/.local/share', () => {
  assert.equal(x86simDataDir({ env: {}, home: '/home/u' }), '/home/u/.local/share/x86sim');
  assert.equal(x86simDataDir({ env: { XDG_DATA_HOME: '/data' }, home: '/home/u' }), '/data/x86sim');
});

const VAR = '/home/u/.local/share/x86sim/var';
const APPIMAGE = '/home/u/x86sim/x86sim-0.5.3-x86_64.AppImage';

test('the only phone is chosen without a flag, and run folders are not phones', async () => {
  const environment = machine({ [VAR]: ['device-a64-iphone-17-pro', 'run', 'run-a64', 'run-a64-iphone-17-pro'] });
  assert.equal(await findDevice(undefined, APPIMAGE, environment), `${VAR}/device-a64-iphone-17-pro`);
});

test('no phone names the command that creates one', async () => {
  await assert.rejects(findDevice(undefined, APPIMAGE, machine({ [VAR]: ['run'] })), (error: Error) => {
    assert.match(error.message, new RegExp(VAR));
    assert.match(error.message, /x86sim device create --model "iPhone 17 Pro"/);
    return true;
  });
});

test('two phones need --device, and the message lists them', async () => {
  const environment = machine({ [VAR]: ['device-a64-iphone-17-pro', 'device-a64-iphone-se'] });
  await assert.rejects(
    findDevice(undefined, APPIMAGE, environment),
    /device-a64-iphone-17-pro, device-a64-iphone-se.*--device/,
  );
});

test('--device takes a name or a folder, and checks that it is a phone', async () => {
  const environment = machine({
    [VAR]: ['device-a64-iphone-17-pro', 'device-a64-iphone-se'],
    [`${VAR}/device-a64-iphone-se`]: ['sim.env', 'data'],
    '/elsewhere/phone': ['sim.env'],
    '/empty': [],
  });
  assert.equal(await findDevice('device-a64-iphone-se', APPIMAGE, environment), `${VAR}/device-a64-iphone-se`);
  assert.equal(await findDevice('/elsewhere/phone', APPIMAGE, environment), '/elsewhere/phone');
  await assert.rejects(findDevice('/empty', APPIMAGE, environment), /no sim\.env.*device list/);
  await assert.rejects(findDevice('device-a64-missing', APPIMAGE, environment), /no sim\.env/);
});
