/** Device points, origin top-left. */
export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Frame = Point & Size;

/**
 * One step of a single-finger touch stream. This is the shape simhid speaks
 * (`touch down|move|up <x> <y>`), and it is also what W3C pointer actions flatten to.
 */
export type TouchEvent =
  | { kind: 'down'; at: Point }
  | { kind: 'move'; at: Point }
  | { kind: 'up'; at: Point }
  | { kind: 'pause'; ms: number };

export type HardwareButton = 'home' | 'lock' | 'volumeUp' | 'volumeDown';

export type AxNode = {
  type: `XCUIElementType${string}`;
  name?: string;
  label?: string;
  value?: string;
  frame: Frame;
  enabled: boolean;
  visible: boolean;
  children: AxNode[];
};

/**
 * The only seam between the protocol layer and a simulator. The server owns WebDriver, the
 * backend owns the device. Quirks of one device (simhid's minimum touch time, normalized
 * coordinates) belong to its backend.
 */
export interface Backend {
  screen(): Promise<Size>;
  /** The root is an `XCUIElementTypeApplication`. */
  accessibilityTree(): Promise<AxNode>;
  /** PNG bytes. */
  screenshot(): Promise<Buffer>;
  /** Replayed in order, pauses honored. */
  touch(events: TouchEvent[]): Promise<void>;
  typeText(text: string): Promise<void>;
  pressButton(button: HardwareButton): Promise<void>;
  installApp(path: string): Promise<void>;
  launchApp(bundleId: string): Promise<void>;
  terminateApp(bundleId: string): Promise<void>;
  openUrl(url: string): Promise<void>;
}

/** A W3C action sequence as WebDriver clients send it. Only pointer sequences carry touch. */
export type W3cPointerAction =
  | { type: 'pointerMove'; duration?: number; x: number; y: number }
  | { type: 'pointerDown' | 'pointerUp'; button?: number }
  | { type: 'pause'; duration?: number };

export type W3cActionSequence =
  | { type: 'pointer'; id: string; parameters?: { pointerType?: string }; actions: W3cPointerAction[] }
  | { type: 'key' | 'none' | 'wheel'; id: string; actions: unknown[] };
