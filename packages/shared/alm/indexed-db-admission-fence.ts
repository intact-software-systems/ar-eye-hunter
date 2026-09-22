import type { IndexedDbAdmissionStoredRow } from './indexed-db-admission-row.ts';

/** A row's first stored revision; every replace commits at the revision it observed plus one. */
export const INDEXED_DB_ADMISSION_FIRST_REVISION = 1;

/**
 * What one key looked like when the write phase observed it: the stored row's identity, or absent.
 * The revision alone cannot carry it -- a recreated row restarts at the first revision -- so the
 * write token it was minted with travels with it.
 */
export type IndexedDbAdmissionObservedRow =
    | Readonly<{ revision: number; writeToken: string; }>
    | 'absent';

/**
 * The keys one write phase's decision depends on. `rows` holds every key it read or wrote with what
 * it observed there; `prefixes` holds every prefix it listed with the keys that list returned, so a
 * row added to or removed from a listed range conflicts even though no read key moved.
 */
export interface IndexedDbAdmissionFence {
    readonly rows: ReadonlyMap<string, IndexedDbAdmissionObservedRow>;
    readonly prefixes: ReadonlyMap<string, readonly string[]>;
}

export function computeIndexedDbAdmissionWriteRevision(
    observed: IndexedDbAdmissionObservedRow
): number {
    return observed === 'absent' ? INDEXED_DB_ADMISSION_FIRST_REVISION : observed.revision + 1;
}

export function toIndexedDbAdmissionObservedRow(
    stored: IndexedDbAdmissionStoredRow | undefined
): IndexedDbAdmissionObservedRow {
    return stored === undefined
        ? 'absent'
        : { revision: stored.revision, writeToken: stored.writeToken };
}

/**
 * Whether the row a fence re-read is still the one the write phase observed. A row deleted and
 * recreated in between restarts at the first revision, so only the write token `set` mints afresh
 * on every write reveals that replacement.
 */
export function isIndexedDbAdmissionObservationUnmoved(
    observed: IndexedDbAdmissionObservedRow,
    current: IndexedDbAdmissionObservedRow
): boolean {
    if (observed === 'absent' || current === 'absent') {
        return observed === current;
    }
    return observed.revision === current.revision && observed.writeToken === current.writeToken;
}

/** Nothing to re-read: every mutation of such a write carries its own per-row guard instead. */
export const EMPTY_INDEXED_DB_ADMISSION_FENCE: IndexedDbAdmissionFence = {
    rows: new Map(),
    prefixes: new Map()
};
