import type { IndexedDbAdmissionStoredRow } from './indexed-db-admission-row.ts';

/** A row's first stored revision; every replace commits at the revision it observed plus one. */
export const INDEXED_DB_ADMISSION_FIRST_REVISION = 1;

/** What one key looked like when the write phase observed it: its stored revision, or absent. */
export type IndexedDbAdmissionObservedRevision = number | 'absent';

/**
 * The keys one write phase's decision depends on. `rows` holds every key it read or wrote with the
 * revision it observed; `prefixes` holds every prefix it listed with the keys that list returned,
 * so a row added to or removed from a listed range conflicts even though no read key moved.
 */
export interface IndexedDbAdmissionFence {
    readonly rows: ReadonlyMap<string, IndexedDbAdmissionObservedRevision>;
    readonly prefixes: ReadonlyMap<string, readonly string[]>;
}

export function computeIndexedDbAdmissionWriteRevision(
    observed: IndexedDbAdmissionObservedRevision
): number {
    return observed === 'absent' ? INDEXED_DB_ADMISSION_FIRST_REVISION : observed + 1;
}

export function toIndexedDbAdmissionObservedRevision(
    stored: IndexedDbAdmissionStoredRow | undefined
): IndexedDbAdmissionObservedRevision {
    return stored === undefined ? 'absent' : stored.revision;
}

/** Nothing to re-read: every mutation of such a write carries its own per-row guard instead. */
export const EMPTY_INDEXED_DB_ADMISSION_FENCE: IndexedDbAdmissionFence = {
    rows: new Map(),
    prefixes: new Map()
};
