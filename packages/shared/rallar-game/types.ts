import type { GroupRef } from '../api/group-types.ts';

export type RallarGameAuthorityKind = 'server' | 'browser-director';

export type RallarGameAuthorityRef = Readonly<{
    kind: RallarGameAuthorityKind;
    id: string;
    epoch: number;
}>;

export type RallarGameAuthorityTypeIds = Readonly<{
    command: string;
    commandResult: string;
    event: string;
    snapshot: string;
    syncRequest: string;
    presence: string;
}>;

export type RallarGameAuthorityEnvelopeKind =
    | 'command'
    | 'command-result'
    | 'event'
    | 'snapshot'
    | 'sync-request'
    | 'presence';

export type RallarGameAuthorityEnvelope<T> = Readonly<{
    protocol: string;
    kind: RallarGameAuthorityEnvelopeKind;
    roomId: string;
    senderId: string;
    seq: number;
    sentAtEpochMs: number;
    authority: RallarGameAuthorityRef;
    payload: T;
}>;

export type RallarGameAuthorityEnvelopeCreateInput<T> = Readonly<{
    protocol: string;
    kind: RallarGameAuthorityEnvelopeKind;
    roomId: string;
    senderId: string;
    seq: number;
    authority: RallarGameAuthorityRef;
    payload: T;
    sentAtEpochMs?: number;
}>;

export type RallarGameAuthorityEnvelopeRejectReason =
    | 'wrong-protocol'
    | 'wrong-room'
    | 'wrong-sender'
    | 'wrong-kind'
    | 'wrong-authority-kind'
    | 'wrong-authority-id'
    | 'stale-authority-epoch'
    | 'duplicate-sequence'
    | 'stale-sequence';

export type RallarGameAuthoritySequenceAcceptConstraints = Readonly<{
    protocol?: string;
    roomId?: string;
    senderId?: string;
    authorityKind?: RallarGameAuthorityKind;
    authorityId?: string;
    minAuthorityEpoch?: number;
    kinds?: readonly RallarGameAuthorityEnvelopeKind[];
}>;

export type RallarGameAuthoritySequenceAcceptResult = Readonly<
    | {
        accepted: true;
        envelope: RallarGameAuthorityEnvelope<unknown>;
    }
    | {
        accepted: false;
        reason: RallarGameAuthorityEnvelopeRejectReason;
        envelope: RallarGameAuthorityEnvelope<unknown>;
    }
>;

export type RallarGameAuthoritySequenceTracker = Readonly<{
    accept(
        envelope: RallarGameAuthorityEnvelope<unknown>,
        constraints?: RallarGameAuthoritySequenceAcceptConstraints
    ): RallarGameAuthoritySequenceAcceptResult;
    last(
        envelope:
            | RallarGameAuthorityEnvelope<unknown>
            | Pick<RallarGameAuthorityEnvelope<unknown>, 'roomId' | 'authority' | 'senderId' | 'kind'>
    ): number | undefined;
    reset(): void;
}>;

export type RallarGameAuthoritySendStatus =
    | 'sent'
    | 'accepted'
    | 'rejected'
    | 'partial'
    | 'skipped'
    | 'failed'
    | 'not-ready'
    | 'stopped';

export type RallarGameAuthorityTransport =
    | 'ws'
    | 'rtc'
    | 'server'
    | 'local';

export type RallarGameAuthoritySendResult = Readonly<{
    status: RallarGameAuthoritySendStatus;
    transport?: RallarGameAuthorityTransport;
    seq?: number;
    reason?: string;
    raw?: unknown;
}>;

export type RallarGameAuthorityCommandResult = Readonly<{
    commandSeq: number;
    status: 'accepted' | 'rejected';
    reason?: string;
}>;

export type RallarGameAuthorityPhase =
    | 'idle'
    | 'connecting'
    | 'ready'
    | 'degraded'
    | 'stopped'
    | 'error';

export type RallarGameAuthorityPeerAssistStatus = Readonly<{
    enabled: boolean;
    snapshotRepairEnabled: boolean;
    readyPeerIds: readonly string[];
    lastPresenceAtEpochMs?: number;
    lastSnapshotRepairAtEpochMs?: number;
}>;

export type RallarGameAuthorityClientStatus = Readonly<{
    phase: RallarGameAuthorityPhase;
    protocol: string;
    topicId: string;
    roomId?: string;
    roomRef?: GroupRef;
    localPeerId?: string;
    authority: RallarGameAuthorityRef;
    started: boolean;
    stopped: boolean;
    pendingCommandCount: number;
    peerAssist: RallarGameAuthorityPeerAssistStatus;
    authorityTtlMs?: number;
    lastAuthoritySeenAtEpochMs?: number;
    lastCommandResultAtEpochMs?: number;
    lastSnapshotAtEpochMs?: number;
    lastEventAtEpochMs?: number;
    updatedAtEpochMs: number;
    reason?: string;
}>;

export type RallarGameAuthorityDiagnosticsInput = Readonly<{
    status: RallarGameAuthorityClientStatus;
    nowEpochMs?: number;
    issues?: readonly string[];
}>;

export type RallarGameAuthorityDiagnostics = Readonly<{
    generatedAtEpochMs: number;
    phase: RallarGameAuthorityPhase;
    roomId?: string;
    localPeerId?: string;
    authority: RallarGameAuthorityRef;
    pendingCommandCount: number;
    peerAssist: RallarGameAuthorityPeerAssistStatus;
    snapshotAgeMs?: number;
    eventAgeMs?: number;
    issues: readonly string[];
}>;

export type RallarGameAuthorityEnvelopeHandler<T> = (
    envelope: RallarGameAuthorityEnvelope<T>
) => void | Promise<void>;

export type RallarGameAuthorityStatusHandler = (
    status: RallarGameAuthorityClientStatus
) => void | Promise<void>;
