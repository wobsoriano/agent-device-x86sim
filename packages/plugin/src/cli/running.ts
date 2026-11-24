import { realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';

const PROBE_TIMEOUT_MS = 5_000;

/** Whether the phone in this folder runs, which is whether its simhid socket accepts a connection. */
export async function isPhoneRunning(device: string): Promise<boolean> {
  try {
    const socketPath = await realpath(path.join(device, 'data', 'simhid.sock'));
    return await new Promise<boolean>((resolve) => {
      const socket = createConnection(socketPath);
      const done = (answer: boolean) => {
        socket.destroy();
        resolve(answer);
      };
      socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  } catch {
    return false;
  }
}
