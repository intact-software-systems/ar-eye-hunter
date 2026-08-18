import type { RallarCrdtSnapshotEnvelope } from '@shared/crdt/mod.ts';

import type { CrdtCanonicalSnapshotEnvelope } from './crdt-mutation-contracts.ts';
import { requireString } from '../../services/exact-object-codec.ts';

export function requireCrdtCanonicalSnapshotReason(value: unknown): asserts value is string {
  requireString(value, 'snapshot reason');
  if (value.trim().length === 0) {
    throw new TypeError('snapshot reason must contain a non-whitespace character');
  }
}

export function toCrdtCanonicalSnapshotEnvelope(
  snapshot: RallarCrdtSnapshotEnvelope,
  reason: string,
): CrdtCanonicalSnapshotEnvelope {
  requireCrdtCanonicalSnapshotReason(reason);
  return {
    ...snapshot,
    metadata: { ...snapshot.metadata, reason },
  };
}
