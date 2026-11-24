import type { AgentDevicePlugin } from 'agent-device/plugins';
import type { WebDriverPluginOptions } from 'agent-device/plugins/webdriver';
import { createAutoServer, findAutoTarget } from './auto-start.ts';
import { DEFAULT_DEVICE, PROVIDER, createConnection, resolveEndpoint } from './connection.ts';
import { X86SIM_PROFILE_FIELDS } from './profile-fields.ts';

export type X86SimOptions = {
  /** The x86sim-webdriver server. Else `X86SIM_WEBDRIVER_ENDPOINT`, else `http://127.0.0.1:4723`. */
  endpoint?: string;
};

type CapabilityOverrides = NonNullable<WebDriverPluginOptions['capabilityOverrides']>;

/**
 * The server answers only the routes behind these operations, so the rest are marked
 * unsupported instead of being sent to a route that cannot answer.
 */
const CAPABILITY_OVERRIDES: CapabilityOverrides = {
  back: { support: 'unsupported', note: 'iOS has no back button and the server has no /back route.' },
  orientation: { support: 'unsupported', note: 'The server has no rotation or orientation routes.' },
  fill: { support: 'unsupported', note: 'The server has no element routes, so there is no focus to fill.' },
  keyboard: { support: 'unsupported', note: 'The server does not report or dismiss the keyboard.' },
  'clipboard.read': { support: 'unsupported', note: 'The server has no clipboard access.' },
  'clipboard.write': { support: 'unsupported', note: 'The server has no clipboard access.' },
};

/** agent-device drives an iOS simulator under x86Sim through its built-in WebDriver engine. */
export default function x86sim(options: X86SimOptions = {}): AgentDevicePlugin {
  return {
    apiVersion: 2,
    provider: PROVIDER,
    credentials: { variables: [] },
    connection: createConnection(options),
    setup: (host) => {
      const auto = createAutoServer();
      return {
        webDriver: {
          provider: PROVIDER,
          profileFields: X86SIM_PROFILE_FIELDS,
          platform: 'ios',
          deviceName: DEFAULT_DEVICE,
          endpoint: resolveEndpoint(options.endpoint, host.env),
          webdriverCapabilities: {
            platformName: 'iOS',
            'appium:automationName': 'XCUITest',
            'appium:deviceName': DEFAULT_DEVICE,
          },
          capabilityOverrides: CAPABILITY_OVERRIDES,
          prepareSession: async ({ base }) => {
            const target = await findAutoTarget(options.endpoint, host.env);
            return target ? { ...base, endpoint: await auto.endpoint(target) } : base;
          },
        },
        dispose: () => auto.close(),
      };
    },
  };
}
