import { readdir, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import type { AxNode, Frame } from '../types.ts';

export const SPRINGBOARD_BUNDLE_ID = 'com.apple.springboard';

/** What one process's hook answers to `tree`. Only SpringBoard says which app is in front. */
export type HookReply = {
  pid: number;
  bundleId: string;
  /** SpringBoard only. `null` is the home screen. */
  front?: { pid: number; bundleId: string } | null;
  root: AxNode;
};

/** The hook names its socket `x86sim-ax-<udid>-<pid>.sock` in the phone's runtime directory. */
const socketName = (udid: string) => new RegExp(`^x86sim-ax-${udid}-\\d+\\.sock$`);

/** The hook sockets of one phone among the files of a directory. */
export function hookSocketNames(files: readonly string[], udid: string): string[] {
  const pattern = socketName(udid);
  return files.filter((file) => pattern.test(file));
}

const MAX_TREE_DEPTH = 80;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(where: string, expected: string): never {
  throw new Error(`Hook reply is malformed at ${where}, expected ${expected}.`);
}

function parseFrame(value: unknown, where: string): Frame {
  if (!isRecord(value)) fail(where, 'an object with x, y, width and height');
  const { x, y, width, height } = value;
  for (const [key, number] of Object.entries({ x, y, width, height })) {
    if (typeof number !== 'number' || !Number.isFinite(number)) fail(`${where}.${key}`, 'a finite number');
  }
  return { x, y, width, height } as Frame;
}

function parseOptionalString(record: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`${where}.${key}`, 'a string');
  return value;
}

function parseNode(value: unknown, where: string, depth: number): AxNode {
  if (!isRecord(value)) fail(where, 'an element object');
  if (depth > MAX_TREE_DEPTH) fail(where, `a tree no deeper than ${MAX_TREE_DEPTH}`);
  const { type, enabled, visible, children } = value;
  if (typeof type !== 'string' || !type.startsWith('XCUIElementType')) fail(`${where}.type`, 'an XCUIElementType name');
  if (typeof enabled !== 'boolean') fail(`${where}.enabled`, 'a boolean');
  if (typeof visible !== 'boolean') fail(`${where}.visible`, 'a boolean');
  if (!Array.isArray(children)) fail(`${where}.children`, 'an array');
  const name = parseOptionalString(value, 'name', where);
  const label = parseOptionalString(value, 'label', where);
  const text = parseOptionalString(value, 'value', where);
  return {
    type: type as AxNode['type'],
    ...(name === undefined ? {} : { name }),
    ...(label === undefined ? {} : { label }),
    ...(text === undefined ? {} : { value: text }),
    frame: parseFrame(value.frame, `${where}.frame`),
    enabled,
    visible,
    children: children.map((child, index) => parseNode(child, `${where}.children[${index}]`, depth + 1)),
  };
}

/** Checks one line of the hook's JSON at the boundary, so nothing downstream sees a loose shape. */
export function parseHookReply(text: string): HookReply {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Hook reply is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(json)) fail('the reply', 'an object');
  if (typeof json.error === 'string') throw new Error(`The hook refused the request: ${json.error}`);
  const { pid, bundleId, front } = json;
  if (typeof pid !== 'number' || !Number.isInteger(pid)) fail('pid', 'an integer');
  if (typeof bundleId !== 'string') fail('bundleId', 'a string');
  const root = parseNode(json.root, 'root', 0);
  if (root.type !== 'XCUIElementTypeApplication') fail('root.type', 'XCUIElementTypeApplication');
  if (front === undefined || front === null) return { pid, bundleId, ...(front === null ? { front: null } : {}), root };
  if (!isRecord(front)) fail('front', 'null or an object with pid and bundleId');
  if (typeof front.pid !== 'number' || !Number.isInteger(front.pid)) fail('front.pid', 'an integer');
  if (typeof front.bundleId !== 'string') fail('front.bundleId', 'a string');
  return { pid, bundleId, front: { pid: front.pid, bundleId: front.bundleId }, root };
}

/** Asks one hook for its tree. Rejects on a dead socket, a timeout, an abort or a malformed answer. */
export function queryHook(socketPath: string, timeoutMs: number, signal: AbortSignal): Promise<HookReply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    const finish = (error: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      reject(error);
    };
    const onAbort = () => finish(new Error(`The query to ${socketPath} was abandoned.`));
    const timer = setTimeout(() => finish(new Error(`No answer from ${socketPath} in ${timeoutMs} ms.`)), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    socket.on('connect', () => socket.write('tree\n'));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', finish);
    socket.on('close', () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      try {
        resolve(parseHookReply(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/** The first value to settle that satisfies `match`, or `undefined` once every promise has settled without one. */
export function firstMatching<T>(
  promises: readonly Promise<T | undefined>[],
  match: (value: T) => boolean,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let pending = promises.length;
    if (pending === 0) resolve(undefined);
    for (const promise of promises) {
      void promise.then((value) => {
        if (value !== undefined && match(value)) resolve(value);
        else if ((pending -= 1) === 0) resolve(undefined);
      });
    }
  });
}

/** SpringBoard names a front app that has not bound its hook socket yet, which a freshly launched app has not. */
export class FrontAppNotListening extends Error {}

const pidOf = (name: string): number => Number(/-(\d+)\.sock$/.exec(name)?.[1]);

/**
 * The accessibility tree of what is on screen. SpringBoard names the app in front, or none for the
 * home screen, so only SpringBoard and that app are waited for. A suspended app takes the
 * connection and never answers, which would cost every other snapshot the full timeout. A socket
 * whose process has died refuses the connection, and its file is removed.
 */
export async function readFrontTree(dir: string, udid: string, timeoutMs: number): Promise<AxNode> {
  const abort = new AbortController();
  const queries = new Map<number, Promise<HookReply | undefined>>();
  for (const name of hookSocketNames(await readdir(dir), udid)) {
    const socketPath = path.join(dir, name);
    queries.set(
      pidOf(name),
      queryHook(socketPath, timeoutMs, abort.signal).catch(async (error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED')
          await unlink(socketPath).catch(() => undefined);
        return undefined;
      }),
    );
  }
  try {
    const springboard = await firstMatching([...queries.values()], (reply) => reply.bundleId === SPRINGBOARD_BUNDLE_ID);
    if (!springboard) throw new Error(`SpringBoard's accessibility hook did not answer in ${dir}.`);
    if (!springboard.front) return springboard.root;
    if (!queries.has(springboard.front.pid)) {
      throw new FrontAppNotListening(
        `The front app ${springboard.front.bundleId} (pid ${springboard.front.pid}) has no hook socket yet.`,
      );
    }
    const app = await queries.get(springboard.front.pid);
    if (!app)
      throw new Error(
        `The front app ${springboard.front.bundleId} (pid ${springboard.front.pid}) did not answer on its hook socket.`,
      );
    return app.root;
  } finally {
    abort.abort();
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * {@link readFrontTree}, which waits up to `waitMs` for an app that was launched a moment ago to
 * bind its hook socket. An app that answers badly, or a phone without SpringBoard's hook, fails at once.
 */
export async function readFrontTreeWhenListening(
  dir: string,
  udid: string,
  timeoutMs: number,
  waitMs: number,
  retryMs = 500,
): Promise<AxNode> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await readFrontTree(dir, udid, timeoutMs);
    } catch (error) {
      if (!(error instanceof FrontAppNotListening) || Date.now() + retryMs > deadline) throw error;
      await sleep(retryMs);
    }
  }
}
