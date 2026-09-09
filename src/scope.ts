import type { Change, TreeManifest, WriteScope } from './contracts.js';
import { portablePath } from './portable-path.js';

/** Deterministic authorization of a baseline-to-candidate delta, not an OS write sandbox.
 * Exact files do not authorize directory replacement. Creating necessary parent directories
 * is allowed, but deleting/replacing a parent requires a tree grant and all children checked. */
export function scopeViolations(scope: WriteScope, changes: Change[], baseline: TreeManifest, candidate: TreeManifest): string[] {
  const aliases = new Map<string, Set<string>>();
  for (const entry of [...baseline.entries, ...candidate.entries]) {
    const key = entry.path.normalize('NFC').toLowerCase(), names = aliases.get(key) ?? new Set<string>();
    names.add(entry.path); aliases.set(key, names);
  }
  const inTree = (path: string) => scope.trees.some(tree => tree === '.' || path === tree || path.startsWith(`${tree}/`));
  const parentNeeded = (path: string) => [...scope.files, ...scope.trees].some(grant => grant.startsWith(`${path}/`));
  return changes.filter(change => {
    const path = change.path, parts = path.split('/');
    if (!portablePath(path) || path !== path.normalize('NFC') || parts.some((_, i) =>
      (aliases.get(parts.slice(0, i + 1).join('/').normalize('NFC').toLowerCase())?.size ?? 0) > 1)) return true;
    if (inTree(path)) return false;
    if (change.kind === 'added' && change.after?.kind === 'directory' && parentNeeded(path)) return false;
    return !scope.files.includes(path) || change.before?.kind === 'directory' || change.after?.kind === 'directory';
  }).map(change => change.path);
}
