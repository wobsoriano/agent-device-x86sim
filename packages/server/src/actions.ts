import { invalidArgument, unsupportedOperation } from './errors.ts';
import type { Point, TouchEvent, W3cActionSequence, W3cPointerAction } from './types.ts';

/** How often an interpolated drag reports a position. 16 ms is about one display frame. */
const MOVE_STEP_MS = 16;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parsePointerAction(raw: unknown): W3cPointerAction {
  if (!isRecord(raw)) throw invalidArgument('Pointer action must be an object.');
  const duration = raw.duration;
  if (duration !== undefined && (typeof duration !== 'number' || !(duration >= 0))) {
    throw invalidArgument('Pointer action duration must be a non-negative number.');
  }
  switch (raw.type) {
    case 'pointerMove':
      if (typeof raw.x !== 'number' || typeof raw.y !== 'number') {
        throw invalidArgument('pointerMove needs numeric x and y.');
      }
      if (raw.origin !== undefined && raw.origin !== 'viewport') {
        throw invalidArgument('Only the viewport pointer origin is supported.');
      }
      return { type: 'pointerMove', x: raw.x, y: raw.y, ...(duration === undefined ? {} : { duration }) };
    case 'pointerDown':
    case 'pointerUp':
      return { type: raw.type };
    case 'pause':
      return { type: 'pause', ...(duration === undefined ? {} : { duration }) };
    default:
      throw invalidArgument(`Unsupported pointer action type: ${String(raw.type)}`);
  }
}

/** The boundary: untrusted `POST /actions` body to typed sequences. */
export function parseActions(body: unknown): W3cActionSequence[] {
  if (!isRecord(body) || !Array.isArray(body.actions)) {
    throw invalidArgument('Request body needs an "actions" array.');
  }
  return body.actions.map((raw): W3cActionSequence => {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !Array.isArray(raw.actions)) {
      throw invalidArgument('Each action sequence needs a string id and an actions array.');
    }
    if (raw.type === 'pointer') {
      const parameters = isRecord(raw.parameters) ? raw.parameters : undefined;
      return {
        type: 'pointer',
        id: raw.id,
        ...(parameters ? { parameters: parameters as { pointerType?: string } } : {}),
        actions: raw.actions.map(parsePointerAction),
      };
    }
    if (raw.type === 'key' || raw.type === 'none' || raw.type === 'wheel') {
      return { type: raw.type, id: raw.id, actions: raw.actions };
    }
    throw invalidArgument(`Unsupported action source type: ${String(raw.type)}`);
  });
}

function lerp(from: Point, to: Point, t: number): Point {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

/**
 * Flattens W3C pointer actions to the single-finger touch stream a simhid-style device takes.
 *
 * - The pointer starts at (0, 0), as in the spec, and `pointerMove` outside a press only
 *   repositions it, so a tap is `down` and `up` at the last position.
 * - A timed drag becomes `move` steps every 16 ms, so the device sees a gesture with velocity
 *   rather than a jump after a wait.
 * - A timed move outside a press becomes a `pause`.
 * - Key, none and wheel sources are ignored here. A second pointer sequence is refused,
 *   because one touch point cannot play two fingers.
 */
export function toTouchEvents(sequences: W3cActionSequence[]): TouchEvent[] {
  const pointers = sequences.filter((sequence) => sequence.type === 'pointer');
  if (pointers.length > 1) {
    throw unsupportedOperation('Multi-pointer actions are not supported by this touch backend.');
  }
  const pointer = pointers[0];
  if (pointer?.type !== 'pointer') return [];

  const events: TouchEvent[] = [];
  let position: Point = { x: 0, y: 0 };
  let pressed = false;

  for (const action of pointer.actions) {
    switch (action.type) {
      case 'pointerMove': {
        const target = { x: action.x, y: action.y };
        const duration = action.duration ?? 0;
        if (!pressed) {
          if (duration > 0) events.push({ kind: 'pause', ms: duration });
        } else if (duration <= MOVE_STEP_MS) {
          events.push({ kind: 'move', at: target });
        } else {
          const steps = Math.ceil(duration / MOVE_STEP_MS);
          for (let step = 1; step <= steps; step += 1) {
            events.push({ kind: 'pause', ms: duration / steps });
            events.push({ kind: 'move', at: step === steps ? target : lerp(position, target, step / steps) });
          }
        }
        position = target;
        break;
      }
      case 'pointerDown':
        if (!pressed) events.push({ kind: 'down', at: position });
        pressed = true;
        break;
      case 'pointerUp':
        if (pressed) events.push({ kind: 'up', at: position });
        pressed = false;
        break;
      case 'pause':
        if ((action.duration ?? 0) > 0) events.push({ kind: 'pause', ms: action.duration ?? 0 });
        break;
    }
  }
  return events;
}
