import type { Annotation } from '../tools/types';

/**
 * Compute the set of superseded annotations.
 *
 * When multiple annotation rounds target the same `linkedSelector`, only the
 * newest round should be visible. This function returns a `Set<Annotation>`
 * containing the *object references* of annotations that are superseded (older
 * rounds plus their group mates).
 *
 * Using object references (instead of ID strings) avoids a subtle bug: if
 * duplicate annotations with the same ID end up in state, adding the ID of the
 * "old" copy also hides the "kept" copy.
 */
export function computeSupersededAnnotations(annotations: Annotation[]): Set<Annotation> {
  const superseded = new Set<Annotation>();

  // Group annotations by linkedSelector
  const bySelector = new Map<string, Annotation[]>();
  for (const a of annotations) {
    if (!a.linkedSelector) continue;
    const group = bySelector.get(a.linkedSelector) || [];
    group.push(a);
    bySelector.set(a.linkedSelector, group);
  }

  // Track which groupIds are superseded vs kept so we can expand mates correctly
  const supersededGroupIds = new Set<string>();
  const keptGroupIds = new Set<string>();

  for (const group of bySelector.values()) {
    if (group.length <= 1) {
      // Single annotation per selector — mark its groupId as kept
      if (group[0]?.groupId) keptGroupIds.add(group[0].groupId);
      continue;
    }

    // Sort by timestamp descending — newest first
    group.sort((a, b) => b.timestamp - a.timestamp);

    // The newest annotation is kept
    const kept = group[0]!;
    if (kept.groupId) keptGroupIds.add(kept.groupId);

    // All but the newest are superseded
    for (let i = 1; i < group.length; i++) {
      const old = group[i]!;
      superseded.add(old);
      if (old.groupId) supersededGroupIds.add(old.groupId);
    }
  }

  // Expand group mates: add annotations whose groupId is superseded but NOT kept
  for (const a of annotations) {
    if (!a.groupId) continue;
    if (supersededGroupIds.has(a.groupId) && !keptGroupIds.has(a.groupId)) {
      superseded.add(a);
    }
  }

  return superseded;
}
