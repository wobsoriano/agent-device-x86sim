import type { HardwareButton, Point, Size, TouchEvent } from '../types.ts';

/** simhid drops a touch that lifts sooner than this after it lands, so `up` is held back. */
export const MIN_TOUCH_MS = 80;
/** How long a hardware button stays down. This is what x86Sim's own `simtouch.py` uses. */
export const BUTTON_HOLD_MS = 100;
/** A touch that begins within this share of the display width of an edge is an edge touch. */
const EDGE_MARGIN = 0.04;

export type Edge = 'top' | 'bottom' | 'left' | 'right';

/** One thing to do on the simhid socket, in order. */
export type SimhidStep = { kind: 'line'; line: string } | { kind: 'wait'; ms: number };

/**
 * The screen edge a touch begins on, which simhid needs for system gestures such as the home
 * indicator and Control Center. Top and bottom win in the corners.
 */
export function edgeAt(at: Point, screen: Size): Edge | undefined {
  const margin = EDGE_MARGIN * screen.width;
  if (at.y >= screen.height - margin) return 'bottom';
  if (at.y <= margin) return 'top';
  if (at.x <= margin) return 'left';
  if (at.x >= screen.width - margin) return 'right';
  return undefined;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function touchLine(phase: 'down' | 'move' | 'up', at: Point, screen: Size, edge?: Edge): string {
  const x = clamp01(at.x / screen.width).toFixed(5);
  const y = clamp01(at.y / screen.height).toFixed(5);
  return `touch ${phase} ${x} ${y}${edge ? ` ${edge}` : ''}`;
}

/**
 * Turns device-point touch events into simhid lines and waits. Points are normalized to the
 * display and clamped to it. A touch that lifts sooner than {@link MIN_TOUCH_MS} after it
 * landed gets a wait before its `up`, counted from the pauses the events themselves carry.
 */
export function touchSteps(events: readonly TouchEvent[], screen: Size): SimhidStep[] {
  const steps: SimhidStep[] = [];
  let pressed = false;
  let heldMs = 0;
  for (const event of events) {
    switch (event.kind) {
      case 'down':
        steps.push({ kind: 'line', line: touchLine('down', event.at, screen, edgeAt(event.at, screen)) });
        pressed = true;
        heldMs = 0;
        break;
      case 'move':
        steps.push({ kind: 'line', line: touchLine('move', event.at, screen) });
        break;
      case 'pause':
        steps.push({ kind: 'wait', ms: event.ms });
        if (pressed) heldMs += event.ms;
        break;
      case 'up':
        if (pressed && heldMs < MIN_TOUCH_MS) steps.push({ kind: 'wait', ms: MIN_TOUCH_MS - heldMs });
        steps.push({ kind: 'line', line: touchLine('up', event.at, screen) });
        pressed = false;
        break;
    }
  }
  return steps;
}

const SIMHID_BUTTON: Record<HardwareButton, string> = {
  home: 'home',
  lock: 'lock',
  volumeUp: 'volup',
  volumeDown: 'voldown',
};

/** A press: down, hold, up. */
export function buttonSteps(button: HardwareButton): SimhidStep[] {
  const name = SIMHID_BUTTON[button];
  return [
    { kind: 'line', line: `button ${name} down` },
    { kind: 'wait', ms: BUTTON_HOLD_MS },
    { kind: 'line', line: `button ${name} up` },
  ];
}

export type DeviceGeometry = {
  /** The panel in device pixels, which is what x86Sim screenshots are made of. */
  pixels: Size;
  /** Pixels per point. WebDriver speaks points. */
  scale: number;
};

/** Reads the panel from a device's `sim.env`, which holds `SIMULATOR_MAINSCREEN_*` lines. */
export function parseSimEnv(text: string): DeviceGeometry {
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const found = /^SIMULATOR_MAINSCREEN_(WIDTH|HEIGHT|SCALE)=(\S+)$/.exec(line.trim());
    if (found?.[1] && found[2]) values.set(found[1], Number(found[2]));
  }
  const width = values.get('WIDTH');
  const height = values.get('HEIGHT');
  const scale = values.get('SCALE');
  if (!(width && height && scale && width > 0 && height > 0 && scale > 0)) {
    throw new Error('sim.env has no usable SIMULATOR_MAINSCREEN_WIDTH, HEIGHT and SCALE.');
  }
  return { pixels: { width, height }, scale };
}

export function pointSize({ pixels, scale }: DeviceGeometry): Size {
  return { width: pixels.width / scale, height: pixels.height / scale };
}
