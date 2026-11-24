import path from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/** One member of a zip. Paths use `/`, relative to the archive root, without a trailing slash. */
export type ZipEntry =
  | { kind: 'directory'; path: string; mode: number }
  | { kind: 'file'; path: string; mode: number; data: Buffer }
  | { kind: 'symlink'; path: string; target: string };

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const MADE_BY_UNIX = 3;
const UTF8_NAMES = 0x0800;
const STORED = 0;
const DEFLATED = 8;
/** 1980-01-01, the earliest date a zip can hold. */
const DOS_DATE = (1 << 5) | 1;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/** The paths macOS adds when it zips a folder, which hold Finder metadata and no part of the app. */
const isMacMetadata = (name: string) => name.startsWith('__MACOSX/') || path.posix.basename(name).startsWith('._');

function safePath(name: string): string {
  const trimmed = name.replace(/\/+$/, '');
  const normal = path.posix.normalize(trimmed);
  if (
    trimmed.length === 0 ||
    name.includes('\\') ||
    path.posix.isAbsolute(normal) ||
    normal === '..' ||
    normal.startsWith('../')
  ) {
    throw new Error(`The zip has an entry outside its folder: ${name}`);
  }
  return normal;
}

function findEnd(bytes: Buffer): number {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 0xffff); offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('The upload is not a zip file.');
}

/** Reads every entry of a zip into memory, checking each file's CRC. */
export function readZip(bytes: Buffer): ZipEntry[] {
  const end = findEnd(bytes);
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('ZIP64 files are not supported.');

  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== CENTRAL_HEADER) throw new Error('The zip central directory is damaged.');
    const madeBy = bytes.readUInt16LE(offset + 4) >> 8;
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const external = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (isMacMetadata(name)) continue;
    if (flags & 1) throw new Error(`The zip entry ${name} is encrypted.`);
    const entryPath = safePath(name);
    const unixMode = madeBy === MADE_BY_UNIX ? external >>> 16 : 0;
    const type = unixMode & S_IFMT;
    if (name.endsWith('/') || type === S_IFDIR) {
      entries.push({ kind: 'directory', path: entryPath, mode: unixMode & 0o777 || 0o755 });
      continue;
    }

    if (bytes.readUInt32LE(localOffset) !== LOCAL_HEADER) throw new Error(`The zip entry ${name} is damaged.`);
    const start = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const raw = bytes.subarray(start, start + compressedSize);
    let data: Buffer;
    if (method === STORED) data = Buffer.from(raw);
    else if (method === DEFLATED) data = inflateRawSync(raw);
    else throw new Error(`The zip entry ${name} uses compression method ${method}, which is not supported.`);
    if (crc32(data) !== crc) throw new Error(`The zip entry ${name} fails its CRC check.`);

    entries.push(
      type === S_IFLNK
        ? { kind: 'symlink', path: entryPath, target: data.toString('utf8') }
        : { kind: 'file', path: entryPath, mode: unixMode & 0o777 || 0o644, data },
    );
  }
  return entries;
}

/** Writes a zip that keeps Unix modes and symlinks, as `zip -y` does. */
export function writeZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.kind === 'directory' ? `${entry.path}/` : entry.path, 'utf8');
    const data =
      entry.kind === 'file' ? entry.data : entry.kind === 'symlink' ? Buffer.from(entry.target) : Buffer.alloc(0);
    const method = entry.kind === 'file' ? DEFLATED : STORED;
    const stored = method === DEFLATED ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const mode =
      entry.kind === 'directory'
        ? S_IFDIR | entry.mode
        : entry.kind === 'file'
          ? S_IFREG | entry.mode
          : S_IFLNK | 0o777;
    const external = ((mode << 16) >>> 0) + (entry.kind === 'directory' ? 0x10 : 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE((MADE_BY_UNIX << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(external, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
