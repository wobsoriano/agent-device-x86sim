import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { NotSetUpError, findPhone, findX86Sim } from '../src/cli/discovery.ts';
import type { Environment } from '../src/cli/discovery.ts';

const DATA = '/home/u/.local/share/x86sim';
const VAR = `${DATA}/var`;

type Machine = {
  /** Folder to its entries. */
  folders?: Record<string, string[]>;
  files?: Record<string, string>;
  links?: Record<string, string>;
  env?: Record<string, string>;
  running?: string[];
  executable?: string[];
};

function machine(setup: Machine = {}): Environment {
  return {
    env: setup.env ?? {},
    home: '/home/u',
    cwd: '/work',
    listDir: async (dir) => setup.folders?.[dir] ?? [],
    readText: async (file) => setup.files?.[file],
    readLink: async (file) => setup.links?.[file],
    isExecutable: async (file) => setup.executable?.includes(file) ?? false,
    isRunning: async (device) => setup.running?.includes(device) ?? false,
  };
}

/** A data folder with the given app versions, each complete. */
const installed = (versions: string[], extra: Machine = {}): Machine => ({
  ...extra,
  folders: {
    [`${DATA}/app`]: versions,
    ...Object.fromEntries(versions.map((version) => [`${DATA}/app/${version}`, ['cli', '.complete']])),
    ...extra.folders,
  },
});

test('without an AppImage, the newest complete copy in the data folder is used', async () => {
  const x86sim = await findX86Sim(
    undefined,
    machine({
      ...installed(['0.4.0', '0.5.3']),
      files: { [`${DATA}/app/0.5.3/DARLING_ID`]: 'id-053\n' },
      links: { [`${DATA}/darling-prefix`]: 'app/0.5.3/darling-userns' },
      env: { PATH: '/usr/bin' },
    }),
  );
  const launch = x86sim.cli(['device', 'list']);
  assert.equal(launch.command, `${DATA}/app/0.5.3/cli/x86sim`);
  assert.equal(launch.env.X86SIM_DARLING_ID, 'id-053');
  assert.equal(launch.env.X86SIM_DARLING_MODE, 'userns');
  assert.equal(launch.env.PATH, `${DATA}/app/0.5.3/bin:/usr/bin`);
  assert.equal(x86sim.dataDir, DATA);
});

test('a copy that was not finished is skipped', async () => {
  const setup = installed(['0.4.0', '0.5.3']);
  setup.folders![`${DATA}/app/0.5.3`] = ['cli'];
  assert.match((await findX86Sim(undefined, machine(setup))).label, /x86Sim 0\.4\.0/);
});

test('the system Darling mode is used unless the prefix link points into the copy', async () => {
  const system = await findX86Sim(
    undefined,
    machine(installed(['0.5.3'], { links: { [`${DATA}/darling-prefix`]: '../../../opt/x86sim/darling' } })),
  );
  assert.equal(system.cli([]).env.X86SIM_DARLING_MODE, 'system');
  const forced = await findX86Sim(undefined, machine(installed(['0.5.3'], { env: { X86SIM_DARLING_MODE: 'userns' } })));
  assert.equal(forced.cli([]).env.X86SIM_DARLING_MODE, 'userns');
});

test('X86SIM_DATA moves the data folder', async () => {
  const setup = installed([], { env: { X86SIM_DATA: '/mine' } });
  setup.folders!['/mine/app'] = ['0.5.3'];
  setup.folders!['/mine/app/0.5.3'] = ['.complete'];
  assert.equal((await findX86Sim(undefined, machine(setup))).dataDir, '/mine');
});

test('no data folder means x86Sim is not set up, and says where to start', async () => {
  await assert.rejects(findX86Sim(undefined, machine()), (error: Error) => {
    assert.ok(error instanceof NotSetUpError);
    assert.equal(error.message, 'x86Sim is not set up. Run: npx agent-device-x86sim setup');
    return true;
  });
});

test('--appimage wins over X86SIM_APPIMAGE, which wins over the data folder', async () => {
  const setup = installed(['0.5.3'], {
    env: { X86SIM_APPIMAGE: '/env/x86sim.AppImage' },
    executable: ['/flag/x86sim.AppImage', '/env/x86sim.AppImage', '/work/rel.AppImage'],
  });
  assert.equal((await findX86Sim('/flag/x86sim.AppImage', machine(setup))).label, '/flag/x86sim.AppImage');
  assert.equal((await findX86Sim(undefined, machine(setup))).label, '/env/x86sim.AppImage');
  assert.equal((await findX86Sim('./rel.AppImage', machine(setup))).label, '/work/rel.AppImage');
});

test('an AppImage that is not executable says to chmod it', async () => {
  await assert.rejects(findX86Sim('/dl/x86sim.AppImage', machine()), /chmod \+x \/dl\/x86sim\.AppImage/);
});

const phones = (entries: Record<string, string>, extra: Machine = {}): Machine => ({
  ...extra,
  folders: { [VAR]: ['run', 'run-a64', ...Object.keys(entries)], ...extra.folders },
  files: {
    ...Object.fromEntries(Object.entries(entries).map(([folder, name]) => [`${VAR}/${folder}/name`, `${name}\n`])),
    ...extra.files,
  },
});

const PRO = 'device-a64-iphone-17-pro';
const SE = 'device-a64-iphone-se';

test('the only phone is chosen, and run folders are not phones', async () => {
  const phone = await findPhone(undefined, DATA, machine(phones({ [PRO]: 'iPhone 17 Pro' })));
  assert.deepEqual(phone, { folder: PRO, path: `${VAR}/${PRO}`, name: 'iPhone 17 Pro' });
});

test('a phone without a name file is shown by its folder', async () => {
  const phone = await findPhone(undefined, DATA, machine({ folders: { [VAR]: [PRO] } }));
  assert.equal(phone.name, PRO);
});

test('with two phones, the one that runs is chosen', async () => {
  const setup = phones({ [PRO]: 'iPhone 17 Pro', [SE]: 'iPhone SE' }, { running: [`${VAR}/${SE}`] });
  assert.equal((await findPhone(undefined, DATA, machine(setup))).name, 'iPhone SE');
});

test('with two phones and none running, the error lists the names and the command that picks one', async () => {
  const setup = phones({ [PRO]: 'iPhone 17 Pro', [SE]: 'iPhone SE' });
  await assert.rejects(findPhone(undefined, DATA, machine(setup)), (error: Error) => {
    assert.match(error.message, /"iPhone 17 Pro", "iPhone SE"/);
    assert.match(error.message, /agent-device connect x86sim --device "iPhone 17 Pro"/);
    return true;
  });
});

test('two phones that run is also a choice to make', async () => {
  const setup = phones({ [PRO]: 'iPhone 17 Pro', [SE]: 'iPhone SE' }, { running: [`${VAR}/${PRO}`, `${VAR}/${SE}`] });
  await assert.rejects(findPhone(undefined, DATA, machine(setup)), /More than one phone runs/);
});

test('no phone says where to create one', async () => {
  await assert.rejects(
    findPhone(undefined, DATA, machine(phones({}))),
    /No phone found in .*Run: npx agent-device-x86sim setup/,
  );
});

test('--device matches the name the launcher shows, in any case, or the folder name', async () => {
  const setup = phones({ [PRO]: 'iPhone 17 Pro', [SE]: 'iPhone SE' });
  assert.equal((await findPhone('iphone se', DATA, machine(setup))).folder, SE);
  assert.equal((await findPhone('iPhone 17 Pro', DATA, machine(setup))).folder, PRO);
  assert.equal((await findPhone(PRO, DATA, machine(setup))).folder, PRO);
});

test('--device that matches nothing lists the phones', async () => {
  const setup = phones({ [PRO]: 'iPhone 17 Pro', [SE]: 'iPhone SE' });
  await assert.rejects(
    findPhone('iPad', DATA, machine(setup)),
    /No phone is named "iPad". The phones are "iPhone 17 Pro", "iPhone SE"/,
  );
});

test('two phones with one name need a folder name', async () => {
  const setup = phones({ [PRO]: 'iPhone', [SE]: 'iPhone' });
  await assert.rejects(findPhone('iPhone', DATA, machine(setup)), new RegExp(`${PRO}, ${SE}`));
});

test('--device with a path takes a phone folder, and checks that it is one', async () => {
  const setup: Machine = { folders: { '/elsewhere/phone': ['sim.env'], '/empty': [] } };
  assert.equal((await findPhone('/elsewhere/phone', DATA, machine(setup))).path, '/elsewhere/phone');
  await assert.rejects(findPhone('/empty', DATA, machine(setup)), /no sim\.env/);
});
