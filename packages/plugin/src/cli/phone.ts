/** What can be seen of the phone without changing it. */
export type PhoneState = {
  /** The simhid socket accepts a connection. */
  running: boolean;
  /** SpringBoard answers on an accessibility hook socket. */
  hooked: boolean;
  /** `com.apple.Accessibility.plist` turns accessibility on. */
  axPrefs: boolean;
};

export type Action = 'stop' | 'write-prefs' | 'boot' | 'wait-home' | 'wait-hook';

/** What the phone is, as far as getting it ready is concerned. */
export type Phase = 'ready' | 'stale' | 'stopped';

export const phaseOf = ({ running, hooked, axPrefs }: PhoneState): Phase => {
  if (!running) return 'stopped';
  return hooked && axPrefs ? 'ready' : 'stale';
};

/**
 * Each phase and what brings the phone to `ready`. A running phone loads the hook and the
 * accessibility preferences only when it boots, so a stale one is stopped and then booted.
 */
export const PLAN: Record<Phase, readonly Action[]> = {
  ready: [],
  stale: ['stop'],
  stopped: ['write-prefs', 'boot', 'wait-home', 'wait-hook'],
};

const PROGRESS: Record<Action, string> = {
  stop: 'Stopping the phone.',
  'write-prefs': 'Turning on accessibility in the phone.',
  boot: 'Booting the phone with the accessibility hook. This takes 1.5 to 6 minutes.',
  'wait-home': 'Waiting for the home screen.',
  'wait-hook': 'Waiting for the hook to answer.',
};

export type PhoneControl = {
  observe(): Promise<PhoneState>;
  perform(action: Action): Promise<void>;
};

/** Stop, then boot, then confirm. A fourth round means something outside this tool keeps changing the phone. */
const MAX_ROUNDS = 3;

/**
 * Brings the phone to `ready` from whatever state it is in. It looks at the phone each round,
 * not at what an earlier run did, so running it again changes nothing once the phone is ready.
 */
export async function preparePhone(control: PhoneControl, log: (line: string) => void): Promise<void> {
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const state = await control.observe();
    const phase = phaseOf(state);
    if (phase === 'ready') {
      log(round === 0 ? 'The phone is already running with the hook loaded.' : 'The phone is ready.');
      return;
    }
    if (phase === 'stale') {
      const reasons = [
        state.hooked ? undefined : 'load the accessibility hook',
        state.axPrefs ? undefined : 'turn on accessibility',
      ];
      log(`Restarting the phone to ${reasons.filter(Boolean).join(' and ')}.`);
    }
    for (const action of PLAN[phase]) {
      log(PROGRESS[action]);
      await control.perform(action);
    }
  }
  throw new Error(
    `The phone is not ready after ${MAX_ROUNDS} attempts. Last seen: ${JSON.stringify(await control.observe())}.`,
  );
}
