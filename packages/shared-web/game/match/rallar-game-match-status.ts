import type { GroupRef } from '@shared/api/group-types.ts';

export type RallarGameMatchPhase =
    | 'idle'
    | 'lobby'
    | 'electing'
    | 'appointed'
    | 'connecting'
    | 'ready'
    | 'active'
    | 'recovering'
    | 'ended'
    | 'stopped'
    | 'error';

export interface RallarGameRecoveryState {
    readonly status: 'idle' | 'recovering' | 'synced' | 'failed';
    readonly reason?: string;
    readonly sinceEpochMs?: number;
    readonly lastSyncRequestedAtEpochMs?: number;
    readonly lastSnapshotAtEpochMs?: number;
}

export type RallarGameDirectorAuthority =
    | 'none'
    | 'candidate'
    | 'active'
    | 'stale';

export type RallarGameEgressState =
    | 'empty'
    | 'warming'
    | 'ready'
    | 'partial'
    | 'timeout'
    | 'failed';

export interface RallarGameEgressStatus {
    readonly reliable: RallarGameEgressState;
    readonly realtime: RallarGameEgressState;
}

export interface RallarGameMatchStatus {
    readonly phase: RallarGameMatchPhase;
    readonly protocol: string;
    readonly topicId: string;
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly localPeerId?: string;
    readonly directorPeerId?: string;
    readonly directorEpoch?: number;
    readonly directorIsFresh: boolean;
    readonly directorAuthority: RallarGameDirectorAuthority;
    readonly egress: RallarGameEgressStatus;
    readonly recovery: RallarGameRecoveryState;
    readonly started: boolean;
    readonly stopped: boolean;
    readonly updatedAtEpochMs: number;
    readonly reason?: string;
}

export type RallarGameStatusHandler = (
    status: RallarGameMatchStatus
) => void | Promise<void>;
