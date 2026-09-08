import { open, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { Fault, type ArtifactDescriptor, type ArtifactFile, type ArtifactPage, type Change, type ChangePage, type TreeManifest } from './contracts.js';
import { treeManifest } from './workspace.js';
import type { Store } from './store.js';

type Record = ArtifactDescriptor & { workspace: string };
const descriptor = ({ workspace: _workspace, ...value }: Record): ArtifactDescriptor => value;

/** A portable path inside a registered tree, never an OS path supplied by the caller. */
export function artifactPath(path: string): string {
  if (!path || path.length > 2048 || /[\\:\u0000-\u001f]/.test(path) || path.split('/').some(part =>
    !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Fault('ARTIFACT_PATH', 'Use a normalized relative file path', 400);
  }
  return path;
}

async function verified(record: Record, signal: AbortSignal): Promise<TreeManifest> {
  let manifest: TreeManifest;
  try { manifest = await treeManifest(record.workspace, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Fault('ARTIFACT_MISSING', 'Registered snapshot is missing');
    throw error;
  }
  if (manifest.digest !== record.digest) throw new Fault('ARTIFACT_CHANGED', 'Registered snapshot no longer matches its digest');
  return manifest;
}

export async function artifactManifest(store: Store, runId: string, artifactId: string, offset: number, limit: number, signal: AbortSignal): Promise<ArtifactPage> {
  const record = store.artifact(runId, artifactId);
  const manifest = await verified(record, signal);
  return { artifact: descriptor(record), entries: manifest.entries.slice(offset, offset + limit), total: manifest.entries.length,
    nextOffset: offset + limit < manifest.entries.length ? offset + limit : null };
}

export async function artifactFile(store: Store, runId: string, artifactId: string, requestedPath: string,
  offset: number, length: number, signal: AbortSignal): Promise<ArtifactFile> {
  const path = artifactPath(requestedPath);
  const record = store.artifact(runId, artifactId);
  const manifest = await verified(record, signal);
  const entry = manifest.entries.find(entry => entry.path === path);
  if (!entry) throw new Fault('NOT_FOUND', 'File is not in the registered artifact', 404);
  if (entry.kind !== 'file') throw new Fault('ARTIFACT_NOT_FILE', 'Artifact entry is a directory', 400);
  if (offset > entry.size) throw new Fault('OFFSET_RANGE', 'Offset exceeds file size', 416);
  const target = join(record.workspace, ...path.split('/'));
  if ((await lstat(target)).isSymbolicLink() || relative(resolve(target), await realpath(target)) !== '') {
    throw new Fault('ARTIFACT_PATH', 'File path must not redirect');
  }
  const file = await open(target, 'r');
  const hash = createHash('sha256'), parts: Buffer[] = [];
  let position = 0;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== entry.size || (stat.mode & 0o111) !== entry.executable) throw new Fault('ARTIFACT_CHANGED', 'File changed before reading');
    const buffer = Buffer.alloc(65_536);
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, entry.size + 1 - position), position);
      if (!bytesRead) break;
      if (position + bytesRead > entry.size) throw new Fault('ARTIFACT_CHANGED', 'File grew while reading');
      hash.update(buffer.subarray(0, bytesRead));
      const start = Math.max(offset, position), end = Math.min(offset + length, position + bytesRead);
      if (end > start) parts.push(Buffer.from(buffer.subarray(start - position, end - position)));
      position += bytesRead;
    }
    if (position !== entry.size || hash.digest('hex') !== entry.digest) throw new Fault('ARTIFACT_CHANGED', 'File content changed while reading');
  } finally { await file.close(); }
  const bytes = Buffer.concat(parts);
  let encoding: 'utf8' | 'base64' = 'utf8', content: string;
  try {
    if (bytes.includes(0)) throw new Error('binary');
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { encoding = 'base64'; content = bytes.toString('base64'); }
  return { artifact: descriptor(record), path, digest: entry.digest, size: entry.size, offset, bytes: bytes.length, encoding, content,
    nextOffset: offset + bytes.length < entry.size ? offset + bytes.length : null };
}

/** Exact tree delta. It describes candidate edits, not proof of correctness or permission to integrate. */
export function compareManifests(before: TreeManifest, after: TreeManifest): Change[] {
  const a = new Map(before.entries.map(entry => [entry.path, entry])), b = new Map(after.entries.map(entry => [entry.path, entry]));
  const changes: Change[] = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const old = a.get(path), next = b.get(path);
    if (!old) changes.push({ path, kind: 'added', after: next! });
    else if (!next) changes.push({ path, kind: 'deleted', before: old });
    else if (old.kind !== next.kind) changes.push({ path, kind: 'type_changed', before: old, after: next });
    else if (old.kind === 'file' && next.kind === 'file' && (old.digest !== next.digest || old.executable !== next.executable)) {
      changes.push({ path, kind: 'modified', before: old, after: next });
    }
  }
  return changes;
}

export async function artifactChanges(store: Store, runId: string, artifactId: string | undefined, offset: number,
  limit: number, signal: AbortSignal): Promise<ChangePage> {
  const run = store.get(runId);
  if (!run.baseline?.artifactId) throw new Fault('BASELINE_MISSING', 'No original baseline is registered for this run');
  const target = artifactId ?? run.candidate?.artifactId;
  if (!target) throw new Fault('CANDIDATE_MISSING', 'No candidate is registered yet');
  const baseline = store.artifact(runId, run.baseline.artifactId), candidate = store.artifact(runId, target);
  if (candidate.kind === 'baseline') throw new Fault('ARTIFACT_KIND', 'Select a candidate or checkpoint artifact');
  const changes = compareManifests(await verified(baseline, signal), await verified(candidate, signal));
  return { baseline: descriptor(baseline), candidate: descriptor(candidate), changes: changes.slice(offset, offset + limit),
    total: changes.length, nextOffset: offset + limit < changes.length ? offset + limit : null };
}
