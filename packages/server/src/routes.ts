import { randomUUID } from 'node:crypto';
import { parseActions, toTouchEvents } from './actions.ts';
import { invalidArgument, invalidSessionId, sessionNotCreated, unknownCommand } from './errors.ts';
import type { Handler, Route } from './router.ts';
import type { Backend, HardwareButton } from './types.ts';
import { toXcuiSource } from './xcui-source.ts';

export type Session = { id: string; capabilities: Record<string, unknown> };

/** At most one session at a time: one simulator, one input device. */
export type SessionStore = { current: Session | undefined };

const SESSION_PREFIX = '/session/:sessionId';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requireString(body: unknown, ...keys: string[]): string {
  if (isRecord(body)) {
    for (const key of keys) {
      const value = body[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  throw invalidArgument(`Request body needs a string "${keys.join('" or "')}".`);
}

const HARDWARE_BUTTONS: Record<string, HardwareButton> = {
  home: 'home',
  volumeup: 'volumeUp',
  volumedown: 'volumeDown',
};

type ScriptHandler = (backend: Backend, args: Record<string, unknown>) => Promise<unknown>;

/** The `mobile:` scripts of XCUITest that this server answers. Others are `unknown command`. */
const MOBILE_SCRIPTS: Record<string, ScriptHandler> = {
  'mobile: pressButton': async (backend, args) => {
    const button = HARDWARE_BUTTONS[String(args.name).toLowerCase()];
    if (!button) throw invalidArgument(`Unsupported hardware button: ${String(args.name)}`);
    await backend.pressButton(button);
    return null;
  },
  'mobile: deepLink': async (backend, args) => {
    await backend.openUrl(requireString(args, 'url'));
    return null;
  },
  'mobile: activateApp': async (backend, args) => {
    await backend.launchApp(requireString(args, 'bundleId', 'appId'));
    return null;
  },
  'mobile: terminateApp': async (backend, args) => {
    await backend.terminateApp(requireString(args, 'bundleId', 'appId'));
    return true;
  },
};

function windowRect(backend: Backend): Promise<unknown> {
  return backend.screen().then((size) => ({ x: 0, y: 0, ...size }));
}

/** The WebDriver and Appium routes this server implements. */
export function webDriverRoutes(backend: Backend, sessions: SessionStore): Route[] {
  const inSession = (method: string, suffix: string, handler: Handler): Route => ({
    method,
    path: `${SESSION_PREFIX}${suffix}`,
    handler,
  });

  return [
    {
      method: 'GET',
      path: '/status',
      handler: async () => ({ ready: true, message: 'x86sim-webdriver ready' }),
    },
    {
      method: 'POST',
      path: '/session',
      handler: async ({ body }) => {
        if (sessions.current) {
          throw sessionNotCreated(`Session ${sessions.current.id} is still active.`);
        }
        const requested = isRecord(body) && isRecord(body.capabilities) ? body.capabilities : {};
        const alwaysMatch = isRecord(requested.alwaysMatch) ? requested.alwaysMatch : {};
        const session: Session = {
          id: randomUUID(),
          capabilities: {
            ...alwaysMatch,
            platformName: 'iOS',
            'appium:automationName': 'XCUITest',
          },
        };
        sessions.current = session;
        return { sessionId: session.id, capabilities: session.capabilities };
      },
    },
    inSession('DELETE', '', async ({ params }) => {
      if (sessions.current?.id === params.sessionId) sessions.current = undefined;
      return null;
    }),
    inSession('GET', '/source', async () => toXcuiSource(await backend.accessibilityTree())),
    inSession('GET', '/screenshot', async () => (await backend.screenshot()).toString('base64')),
    inSession('GET', '/window/rect', async () => await windowRect(backend)),
    inSession('POST', '/actions', async ({ body }) => {
      const events = toTouchEvents(parseActions(body));
      if (events.length > 0) await backend.touch(events);
      return null;
    }),
    inSession('DELETE', '/actions', async () => null),
    inSession('POST', '/keys', async ({ body }) => {
      const value = isRecord(body) ? body.value : undefined;
      if (!Array.isArray(value)) throw invalidArgument('Request body needs a "value" array.');
      await backend.typeText(value.map(String).join(''));
      return null;
    }),
    inSession('POST', '/appium/device/install_app', async ({ body }) => {
      await backend.installApp(requireString(body, 'appPath'));
      return null;
    }),
    inSession('POST', '/appium/device/activate_app', async ({ body }) => {
      await backend.launchApp(requireString(body, 'appId', 'bundleId'));
      return null;
    }),
    inSession('POST', '/appium/device/terminate_app', async ({ body }) => {
      await backend.terminateApp(requireString(body, 'appId', 'bundleId'));
      return true;
    }),
    inSession('POST', '/execute/sync', async ({ body }) => {
      const script = requireString(body, 'script');
      const handler = MOBILE_SCRIPTS[script];
      if (!handler) throw unknownCommand(`Unknown mobile command: ${script}`);
      const args = isRecord(body) && Array.isArray(body.args) ? body.args[0] : undefined;
      return await handler(backend, isRecord(args) ? args : {});
    }),
  ];
}

export function requireActiveSession(sessions: SessionStore, id: string): Session {
  if (sessions.current?.id !== id) throw invalidSessionId(id);
  return sessions.current;
}
