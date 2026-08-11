import type { GroupRef } from '@shared/api/group-types.ts';

export class RtcTopologySnapshotRevisionConflictError extends Error {
    readonly ref: GroupRef;

    constructor(ref: GroupRef) {
        super(`RTC topology snapshot revision conflict: ${JSON.stringify(ref)}`);
        this.ref = ref;
        this.name = 'RtcTopologySnapshotRevisionConflictError';
    }
}

export class RtcTopologyRepositoryInvariantCorruptionError extends Error {
    readonly code = 'rtc-topology-repository-invariant-corruption';

    readonly storageKey: string;

    constructor(storageKey: string, message: string) {
        super(`${message}: ${storageKey}`);
        this.storageKey = storageKey;
        this.name = 'RtcTopologyRepositoryInvariantCorruptionError';
    }
}
