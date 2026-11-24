import assert from 'node:assert/strict';
import { test } from 'node:test';
import x86sim from '../src/index.ts';
import { X86SIM_PROFILE_FIELDS } from '../src/profile-fields.ts';

const host = { env: {}, options: {}, clientVersion: 'test', createError: () => new Error('unused') };

test('declares an apiVersion 2 provider with no credential variables', () => {
  const plugin = x86sim();
  assert.equal(plugin.apiVersion, 2);
  assert.equal(plugin.provider, 'x86sim');
  assert.deepEqual(plugin.credentials.variables, []);
});

test('refuses every cloud profile field', () => {
  assert.ok(Object.keys(X86SIM_PROFILE_FIELDS.fields).length > 0);
  for (const [field, use] of Object.entries(X86SIM_PROFILE_FIELDS.fields)) {
    assert.equal(use, 'refused', field);
  }
});

test('setup describes an iOS WebDriver service at the option endpoint', async () => {
  const setup = await x86sim({ endpoint: 'http://127.0.0.1:9999' }).setup(host as never);
  assert.ok('webDriver' in setup);
  assert.equal(setup.webDriver.provider, 'x86sim');
  assert.equal(setup.webDriver.platform, 'ios');
  assert.equal(setup.webDriver.endpoint, 'http://127.0.0.1:9999');
});

test('endpoint falls back to the environment, then to localhost', async () => {
  const fromEnv = await x86sim().setup({ ...host, env: { X86SIM_WEBDRIVER_ENDPOINT: 'http://sim:1' } } as never);
  assert.ok('webDriver' in fromEnv);
  assert.equal(fromEnv.webDriver.endpoint, 'http://sim:1');
  const fallback = await x86sim().setup(host as never);
  assert.ok('webDriver' in fallback);
  assert.equal(fallback.webDriver.endpoint, 'http://127.0.0.1:4723');
});

test('operations the server cannot answer are marked unsupported', async () => {
  const setup = await x86sim().setup(host as never);
  assert.ok('webDriver' in setup);
  const overrides = setup.webDriver.capabilityOverrides ?? {};
  for (const operation of ['back', 'orientation', 'fill', 'keyboard'] as const) {
    assert.deepEqual(
      typeof overrides[operation] === 'object' ? overrides[operation]?.support : overrides[operation],
      'unsupported',
    );
  }
});

test('snapshot is marked partial with a note, because the tree is root-only', async () => {
  const setup = await x86sim().setup(host as never);
  assert.ok('webDriver' in setup);
  const snapshot = setup.webDriver.capabilityOverrides?.snapshot;
  assert.ok(typeof snapshot === 'object');
  assert.equal(snapshot.support, 'partial');
  assert.match(snapshot.note ?? '', /root/);
});
