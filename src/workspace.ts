import { mkdir, readdir, lstat, copyFile, realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { relative, isAbsolute, join, resolve, dirname } from 'node:path';
import { Fault } from './contracts.js';

export const inside = (parent: string, child: string): boolean => {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};
const excluded = new Set(['.git', 'node_modules', '.teamwork', '.env', '.npmrc']);

/** Independent working copy; no hardlinks, no user-tree writes, no automatic integration. */
export async function snapshot(source: string, target: string, signal: AbortSignal, exact = false): Promise<void> {
  if ((await lstat(source)).isSymbolicLink()) throw new Fault('WORKSPACE_SYMLINK', 'Source root must not be a link');
  const resolvedSource = await realpath(source);
  if (relative(resolve(source), resolvedSource) !== '') throw new Fault('WORKSPACE_SYMLINK', 'Source ancestors must not redirect the workspace');
  source = resolvedSource;
  if (inside(source, target) || inside(target, source)) {
    throw new Fault('WORKSPACE_OVERLAP', 'Runtime data must be outside the source workspace');
  }
  signal.throwIfAborted();
  await mkdir(dirname(target), { recursive: true });
  if (relative(resolve(dirname(target)), await realpath(dirname(target))) !== '') throw new Fault('WORKSPACE_SYMLINK', 'Target ancestors must not redirect the workspace');
  // Never reuse an existing target, including a symlink planted beside a worker directory.
  await mkdir(target);
  let count = 0, bytes = 0;
  const visit = async (from: string, to: string): Promise<void> => {
    signal.throwIfAborted();
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      signal.throwIfAborted();
      if (!exact && (excluded.has(entry.name) || entry.name.startsWith('.env.'))) continue;
      if (++count > 20_000) throw new Fault('WORKSPACE_TOO_LARGE', 'Snapshot exceeds 20,000 entries');
      const src = join(from, entry.name), dst = join(to, entry.name);
      const info = await lstat(src);
      if (info.isSymbolicLink()) throw new Fault('WORKSPACE_SYMLINK', 'Symbolic links/junctions are not supported in the first slice');
      if (info.isDirectory()) await visit(src, dst);
      else if (info.isFile()) {
        if ((bytes += info.size) > 100 * 1024 * 1024) {
          throw new Fault('WORKSPACE_TOO_LARGE', 'Snapshot exceeds 20,000 files or 100 MiB');
        }
        await copyFile(src, dst);
      } else throw new Fault('WORKSPACE_SPECIAL_FILE', 'Only regular files and directories are supported');
    }
  };
  await visit(source, target);
}

/** Content-addressed manifest includes paths, empty directories and executable bits. */
export async function treeDigest(root: string, signal: AbortSignal): Promise<string> {
  if (relative(resolve(root), await realpath(root)) !== '') throw new Fault('WORKSPACE_SYMLINK', 'Manifest path must not redirect');
  if ((await lstat(root)).isSymbolicLink()) throw new Fault('WORKSPACE_SYMLINK', 'Manifest root must not be a link');
  const hash = createHash('sha256');
  let entries = 0, bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    signal.throwIfAborted();
    for (const name of (await readdir(directory)).sort()) {
      signal.throwIfAborted();
      if (++entries > 20_000) throw new Fault('WORKSPACE_TOO_LARGE', 'Manifest exceeds entry limit');
      const path = join(directory, name), stat = await lstat(path);
      const rel = relative(root, path).replaceAll('\\', '/');
      if (stat.isSymbolicLink()) throw new Fault('WORKSPACE_SYMLINK', 'Candidate must not contain links');
      if (stat.isDirectory()) { hash.update(JSON.stringify(['directory', rel]) + '\n'); await visit(path); }
      else if (stat.isFile()) {
        if ((bytes += stat.size) > 100 * 1024 * 1024) throw new Fault('WORKSPACE_TOO_LARGE', 'Manifest exceeds byte limit');
        const content = await readFile(path);
        hash.update(JSON.stringify(['file', rel, stat.mode & 0o111, createHash('sha256').update(content).digest('hex')]) + '\n');
      } else throw new Fault('WORKSPACE_SPECIAL_FILE', 'Candidate must contain regular files only');
    }
  };
  await visit(root);
  return hash.digest('hex');
}

/** Build outputs may be added, but acceptance may not rewrite/delete candidate inputs. */
export async function inputsUnchanged(candidate: string, copy: string, signal: AbortSignal): Promise<boolean> {
  try {
    if ((await lstat(copy)).isSymbolicLink()) return false;
    for (const name of await readdir(candidate)) {
      signal.throwIfAborted();
      const original = join(candidate, name), other = join(copy, name);
      const a = await lstat(original), b = await lstat(other);
      if (a.isSymbolicLink() || b.isSymbolicLink()) return false;
      if (a.isDirectory()) {
        if (!b.isDirectory() || !await inputsUnchanged(original, other, signal)) return false;
      } else if (a.isFile()) {
        if (!b.isFile() || a.size !== b.size || (a.mode & 0o111) !== (b.mode & 0o111) ||
            !(await readFile(original)).equals(await readFile(other))) return false;
      } else return false;
    }
    return true;
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
