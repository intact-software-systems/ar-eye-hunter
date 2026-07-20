import type { GroupRef } from '@shared/api/group-types.ts';

export class RtcTopologySnapshotRevisionConflictError extends Error {
    constructor(readonly ref: GroupRef) {
        super(`RTC topology snapshot revision conflict: ${JSON.stringify(ref)}`);
        this.name = 'RtcTopologySnapshotRevisionConflictError';
    }
}

export class RtcTopologyRepositoryInvariantCorruptionError extends Error {
    readonly code = 'rtc-topology-repository-invariant-corruption';

    constructor(readonly storageKey: string, message: string) {
        super(`${message}: ${storageKey}`);
        this.name = 'RtcTopologyRepositoryInvariantCorruptionError';
    }
}
