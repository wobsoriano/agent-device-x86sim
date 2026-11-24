import type { Route } from '../router.ts';
import type { AxNode, Backend, HardwareButton, Size, TouchEvent } from '../types.ts';

/** A 1x1 transparent PNG. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const SCREEN: Size = { width: 390, height: 844 };

export const FAKE_CONTINUE_FRAME = { x: 24, y: 700, width: 160, height: 48 } as const;
export const FAKE_EMAIL_FRAME = { x: 24, y: 600, width: 342, height: 44 } as const;

function cannedTree(): AxNode {
  return {
    type: 'XCUIElementTypeApplication',
    name: 'FakeApp',
    label: 'FakeApp',
    frame: { x: 0, y: 0, ...SCREEN },
    enabled: true,
    visible: true,
    children: [
      {
        type: 'XCUIElementTypeOther',
        name: 'Content',
        frame: { x: 0, y: 0, ...SCREEN },
        enabled: true,
        visible: true,
        children: [
          {
            type: 'XCUIElementTypeTextField',
            name: 'Email',
            label: 'Email',
            value: '',
            frame: FAKE_EMAIL_FRAME,
            enabled: true,
            visible: true,
            children: [],
          },
          {
            type: 'XCUIElementTypeButton',
            name: 'Continue',
            label: 'Continue',
            frame: FAKE_CONTINUE_FRAME,
            enabled: true,
            visible: true,
            children: [],
          },
        ],
      },
    ],
  };
}

export type FakeCall = { seq: number; call: string; args: Record<string, unknown> };

/**
 * A backend with a canned screen that records every call. Touch events are recorded, not
 * played, so their pauses are not waited out.
 */
export class FakeBackend implements Backend {
  readonly calls: FakeCall[] = [];

  #record(call: string, args: Record<string, unknown> = {}): void {
    this.calls.push({ seq: this.calls.length + 1, call, args });
  }

  async screen(): Promise<Size> {
    this.#record('screen');
    return SCREEN;
  }
  async accessibilityTree(): Promise<AxNode> {
    this.#record('accessibilityTree');
    return cannedTree();
  }
  async screenshot(): Promise<Buffer> {
    this.#record('screenshot');
    return PNG_1X1;
  }
  async touch(events: TouchEvent[]): Promise<void> {
    this.#record('touch', { events });
  }
  async typeText(text: string): Promise<void> {
    this.#record('typeText', { text });
  }
  async pressButton(button: HardwareButton): Promise<void> {
    this.#record('pressButton', { button });
  }
  async installApp(path: string): Promise<void> {
    this.#record('installApp', { path });
  }
  async launchApp(bundleId: string): Promise<void> {
    this.#record('launchApp', { bundleId });
  }
  async terminateApp(bundleId: string): Promise<void> {
    this.#record('terminateApp', { bundleId });
  }
  async openUrl(url: string): Promise<void> {
    this.#record('openUrl', { url });
  }
}

/** Debug endpoints for tests. They are not WebDriver and exist only on the fake backend. */
export function fakeRoutes(backend: FakeBackend): Route[] {
  return [
    {
      method: 'GET',
      path: '/__fake/log',
      handler: async () => ({ reply: { status: 200, json: { calls: backend.calls } } }),
    },
    {
      method: 'DELETE',
      path: '/__fake/log',
      handler: async () => {
        backend.calls.length = 0;
        return { reply: { status: 200, json: { calls: [] } } };
      },
    },
  ];
}
