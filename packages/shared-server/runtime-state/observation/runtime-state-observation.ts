import { requireString } from '@shared/api/exact-object-decoding.ts';
import { assertRuntimeStateExpectedRevision, type RuntimeStateEntry } from '../runtime-state-repository.ts';

/** A point read a write depends on without rewriting it; `null` is a missing or expired row. */
export interface RuntimeStateObservation {
    readonly namespace: string;
    readonly key: string;
    readonly entry: RuntimeStateEntry | null;
}

/** The observations frozen into their SQL parameter before transaction entry. */
export interface RuntimeStateObservations {
    readonly count: number;
    readonly observationsJson: string;
}

export function computeRuntimeStateObservations(
    observations: readonly RuntimeStateObservation[]
): RuntimeStateObservations {
    const rows = observations.map(({ namespace, key, entry }) => {
        requireString(namespace, 'Observed runtime-state namespace');
        requireString(key, 'Observed runtime-state key');
        if (entry !== null) {
            if (entry.key !== key) {
                throw new TypeError('Observed runtime-state row differs from its requested key');
            }
            assertRuntimeStateExpectedRevision(entry.revision);
        }
        return {
            namespace,
            key,
            revision: entry?.revision ?? null,
            value: entry?.value ?? null,
            expires: entry === null ? null : new Date(entry.expireAtTimestamp).toISOString()
        };
    });
    if (new Set(rows.map(({ namespace, key }) => JSON.stringify([namespace, key]))).size !== rows.length) {
        throw new TypeError('Runtime-state observations repeat a row');
    }
    return { count: rows.length, observationsJson: JSON.stringify(rows) };
}
