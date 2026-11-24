import { readdir, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import type { AxNode, Frame } from '../types.ts';

/** What one process's hook answers to `tree`. */
export type HookReply = {
  pid: number;
  bundleId: string;
  /** The process is the front app, or SpringBoard. */
  active: boolean;
  root: AxNode;
};

export const SPRINGBOARD_BUNDLE_ID = 'com.apple.springboard';
/** The keyboard's process is active whenever the keyboard is up, and is never the app being driven. */
const SYSTEM_UI_BUNDLE_ID = /InputUI/;

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
  const { pid, bundleId, active } = json;
  if (typeof pid !== 'number' || !Number.isInteger(pid)) fail('pid', 'an integer');
  if (typeof bundleId !== 'string') fail('bundleId', 'a string');
  if (typeof active !== 'boolean') fail('active', 'a boolean');
  const root = parseNode(json.root, 'root', 0);
  if (root.type !== 'XCUIElementTypeApplication') fail('root.type', 'XCUIElementTypeApplication');
  return { pid, bundleId, active, root };
}

/**
 * The tree to show. An app that is in front wins over SpringBoard, because SpringBoard's windows
 * stay behind it. With no app in front the screen is the home screen, SpringBoard's.
 * Among several active apps the newest process wins, since pids grow with launch order. A process
 * with no window has nothing on screen, so it is no app in front.
 */
export function chooseReply(replies: readonly HookReply[]): HookReply | undefined {
  const active = replies.filter((reply) => reply.active);
  const apps = active.filter(
    (reply) =>
      reply.bundleId !== SPRINGBOARD_BUNDLE_ID && !SYSTEM_UI_BUNDLE_ID.test(reply.bundleId) && reply.root.children.length > 0,
  );
  const newest = apps.reduce<HookReply | undefined>((best, reply) => (best && best.pid > reply.pid ? best : reply), undefined);
  return newest ?? active.find((reply) => reply.bundleId === SPRINGBOARD_BUNDLE_ID);
}

/** Asks one hook for its tree. Rejects on a dead socket, a timeout or a malformed answer. */
export function queryHook(socketPath: string, timeoutMs: number): Promise<HookReply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      socket.destroy();
      clearTimeout(timer);
      if (error) reject(error);
    };
    const timer = setTimeout(() => finish(new Error(`No answer from ${socketPath} in ${timeoutMs} ms.`)), timeoutMs);
    socket.on('connect', () => socket.write('tree\n'));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', finish);
    socket.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(parseHookReply(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/**
 * Asks every hook of one phone in parallel and keeps the answers that came. A socket whose process
 * has died refuses the connection, and its file is removed.
 */
export async function collectReplies(dir: string, udid: string, timeoutMs: number): Promise<HookReply[]> {
  const names = hookSocketNames(await readdir(dir), udid);
  const settled = await Promise.allSettled(
    names.map(async (name) => {
      const socketPath = path.join(dir, name);
      try {
        return await queryHook(socketPath, timeoutMs);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED') await unlink(socketPath).catch(() => undefined);
        throw error;
      }
    }),
  );
  return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}
