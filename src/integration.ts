import { createHash } from 'node:crypto';
import { Fault, type TreeEntry, type TreeManifest, type IntegrationPlan, type IntegrationConflict } from './contracts.js';
import { artifactPath, compareManifests } from './artifacts.js';
import { excludedSourceName } from './workspace.js';

const key = (path: string): string => path.normalize('NFC').toLowerCase();
const prefixesOf = (path: string): string[] => path.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'));
function same(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === 'directory' ? b.kind === 'directory' : b.kind === 'file' &&
    a.digest === b.digest && a.size === b.size && a.executable === b.executable;
}
function index(manifest: TreeManifest): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const entry of manifest.entries) {
    artifactPath(entry.path);
    if (/[<>"|?*]/.test(entry.path) || entries.has(entry.path)) throw new Fault('INTEGRATION_PATH', 'Unsupported or duplicate integration path');
    entries.set(entry.path, entry);
  }
  for (const path of entries.keys()) {
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (path.includes('/') && entries.get(parent)?.kind !== 'directory') throw new Fault('INTEGRATION_TREE', 'Manifest has an absent or non-directory parent');
  }
  return entries;
}

/** Pure three-way preflight. No file writes, Git operations, automatic text merge or Gate bypass.
 * Unrelated target edits are preserved; any conflict blocks the entire future integration.
 * An apply disposition describes intent only: effects must revalidate under an owned journal. */
export function planIntegration(baseline: TreeManifest, candidate: TreeManifest, target: TreeManifest,
  protectedPaths: readonly string[] = []): IntegrationPlan {
  const before = index(baseline), after = index(candidate), current = index(target);
  const barriers = [...new Set(protectedPaths)].sort();
  barriers.forEach(artifactPath);
  const aliases = new Map<string, Set<string>>();
  for (const path of [...before.keys(), ...after.keys(), ...current.keys(), ...barriers]) {
    const normalized = key(path), values = aliases.get(normalized) ?? new Set<string>();
    values.add(path); aliases.set(normalized, values);
  }
  const changes = compareManifests(baseline, candidate);
  const delta = new Map(changes.map(change => [change.path, change]));
  const changedContainers = new Set<string>(), protectedContainers = new Set<string>();
  for (const [path, entry] of current) if (!same(entry, before.get(path))) {
    for (const parent of prefixesOf(path).slice(0, -1)) changedContainers.add(parent);
  }
  for (const barrier of barriers) for (const parent of prefixesOf(key(barrier)).slice(0, -1)) protectedContainers.add(parent);
  const planned = changes.map(change => {
    const reasons = new Set<IntegrationConflict>();
    const path = change.path, now = current.get(path);
    const prefixes = prefixesOf(path);
    if (prefixes.some(prefix => (aliases.get(key(prefix))?.size ?? 0) > 1)) reasons.add('path_alias');
    if (path.split('/').some(excludedSourceName)) reasons.add('protected_path');
    if (!same(now, change.before) && !same(now, change.after)) reasons.add('concurrent_change');

    if (change.after) for (const ancestor of prefixes.slice(0, -1)) {
      const present = current.get(ancestor);
      if (present?.kind === 'directory') continue;
      const edit = delta.get(ancestor);
      // Parent may be created/replaced by this same plan, but only from its expected baseline.
      if (!edit || edit.after?.kind !== 'directory' || !same(present, edit.before)) reasons.add('ancestor_changed');
    }

    if (change.before?.kind === 'directory' && change.after?.kind !== 'directory') {
      if (changedContainers.has(path)) reasons.add('descendant_changed');
      // Hidden/excluded descendants must survive even if ordinary entries look unchanged.
      if (protectedContainers.has(key(path))) reasons.add('protected_path');
    }
    return { ...change, disposition: reasons.size ? 'conflict' as const : same(now, change.after) ? 'already_applied' as const : 'apply' as const,
      reasons: [...reasons].sort() };
  });
  // Entries as well as digests bind the ID; pure callers cannot accidentally reuse a supplied digest
  // with different data. Sorted inputs make the plan stable across entry iteration order.
  const ordered = (entries: Map<string, TreeEntry>): unknown[] => [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(e => e.kind === 'directory' ? [e.path, e.kind] : [e.path, e.kind, e.size, e.executable, e.digest]);
  const id = createHash('sha256').update(JSON.stringify(['integration-plan-v1', baseline.digest, candidate.digest, target.digest,
    ordered(before), ordered(after), ordered(current), barriers, planned])).digest('hex');
  return { id, baselineDigest: baseline.digest, candidateDigest: candidate.digest, targetDigest: target.digest,
    status: planned.some(change => change.disposition === 'conflict') ? 'conflicts' : 'clear', changes: planned };
}
