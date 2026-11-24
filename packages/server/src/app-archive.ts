import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readZip, writeZip } from './zip.ts';
import type { ZipEntry } from './zip.ts';

const isApp = (name: string) => name.endsWith('.app');

async function treeEntries(root: string, prefix: string): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  for (const child of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, child.name);
    const inZip = `${prefix}/${child.name}`;
    const stats = await lstat(full);
    if (stats.isSymbolicLink()) entries.push({ kind: 'symlink', path: inZip, target: await readlink(full) });
    else if (stats.isDirectory()) {
      entries.push({ kind: 'directory', path: inZip, mode: 0o755 });
      entries.push(...(await treeEntries(full, inZip)));
    } else {
      // Windows reports no execute bit, and the app's own executable needs one.
      const mode = process.platform === 'win32' ? 0o755 : stats.mode & 0o777;
      entries.push({ kind: 'file', path: inZip, mode, data: await readFile(full) });
    }
  }
  return entries;
}

/** The zip to upload for `appPath`: a `.zip` as it is, or a `.app` folder zipped with its modes and symlinks. */
export async function appArchive(appPath: string): Promise<Buffer> {
  const stats = await lstat(appPath).catch(() => undefined);
  if (stats?.isFile() && appPath.toLowerCase().endsWith('.zip')) return await readFile(appPath);
  if (stats?.isDirectory() && isApp(path.basename(appPath))) {
    const name = path.basename(appPath);
    return writeZip([{ kind: 'directory', path: name, mode: 0o755 }, ...(await treeEntries(appPath, name))]);
  }
  throw new Error(`x86Sim installs an arm64 iOS simulator .app folder, or a .zip that holds one. Got: ${appPath}`);
}

/** Writes the entries under `dir`. Symlinks come last and must point inside `dir`, so no file is written through one. */
async function unpack(entries: readonly ZipEntry[], dir: string): Promise<void> {
  for (const entry of entries) {
    const target = path.join(dir, entry.path);
    if (entry.kind === 'directory') await mkdir(target, { recursive: true, mode: entry.mode });
    else if (entry.kind === 'file') {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.data, { mode: entry.mode });
    }
  }
  for (const entry of entries) {
    if (entry.kind !== 'symlink') continue;
    const link = path.join(dir, entry.path);
    const resolved = path.resolve(path.dirname(link), entry.target);
    if (path.isAbsolute(entry.target) || !resolved.startsWith(`${dir}${path.sep}`)) {
      throw new Error(`The zip has a link that points outside its folder: ${entry.path} -> ${entry.target}`);
    }
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(entry.target, link);
  }
}

/** Uploaded apps, each unpacked in its own folder under `root` until it is installed. */
export type Uploads = {
  /** Unpacks a zip and returns the path of the one `.app` at its top. */
  stage(zip: Buffer): Promise<string>;
  /** Removes the folder of a staged app. Paths outside `root` are left alone. */
  release(appPath: string): Promise<void>;
};

export function createUploads(root: string): Uploads {
  return {
    async stage(zip) {
      const dir = path.join(root, randomUUID());
      await mkdir(dir, { recursive: true });
      try {
        await unpack(readZip(zip), dir);
        const apps = (await readdir(dir, { withFileTypes: true })).filter(
          (child) => child.isDirectory() && isApp(child.name),
        );
        if (apps.length !== 1) {
          throw new Error(`The zip must hold one .app folder at its top. It holds ${apps.length}.`);
        }
        return path.join(dir, apps[0]!.name);
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
    },
    async release(appPath) {
      const [folder] = path.relative(root, appPath).split(path.sep);
      if (!folder || folder === '..' || path.isAbsolute(folder)) return;
      await rm(path.join(root, folder), { recursive: true, force: true });
    },
  };
}
