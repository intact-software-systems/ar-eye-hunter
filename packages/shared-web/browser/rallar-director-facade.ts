import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarMessageSendResult } from '@shared-web/browser/rallar-message-contracts.ts';
import type { RallarTargetedSendResult } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { RallarGroupDirectorAppointment, RallarGroupDirectorFreshness } from '@shared/api/group-director.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export type RallarDirectorRole = 'none' | 'director' | 'client';

export type RallarDirectorState =
    | 'none'
    | 'fresh'
    | 'stale'
    | 'inactive';

export type RallarDirectorStatus = Readonly<{
    roomRef?: GroupRef;
    roomId?: string;
    role: RallarDirectorRole;
    state: RallarDirectorState;
    appointment?: RallarGroupDirectorAppointment;
    isDirector: boolean;
    isFresh: boolean;
    active: boolean;
    freshness: RallarGroupDirectorFreshness;
    lastHeartbeatAtEpochMs?: number;
    nowEpochMs: number;
}>;

export type RallarDirectorAppointOptions =
    & RallarScopedOperationOptions
    & Readonly<{
        heartbeatTtlMs?: number;
    }>;

export type RallarDirectorResignOptions = RallarScopedOperationOptions;

export type RallarDirectorStatusOptions = Readonly<{
    now?: number;
}>;

export type RallarDirectorStatusListener = (
    status: RallarDirectorStatus
) => void | Promise<void>;

export type RallarDirectorRelayEnvelope<T = unknown> = Readonly<{
    protocol: 'rallar.director.relay.v1';
    topicId: string;
    typeId: string;
    roomId: string;
    epoch: number;
    sentAtEpochMs: number;
    payload: T;
}>;

export type RallarDirectorRelayMessage<T> = Readonly<{
    transport: 'rtc' | 'ws';
    senderId: string;
    data: T;
    envelope: RallarDirectorRelayEnvelope<T>;
    receivedAtEpochMs: number;
}>;

export type RallarDirectorRelaySendStatus =
    | 'sent'
    | 'partial'
    | 'no-director'
    | 'not-director'
    | 'stale-director'
    | 'failed';

export type RallarDirectorRelaySendResult = Readonly<{
    status: RallarDirectorRelaySendStatus;
    rtc?: RallarTargetedSendResult | RallarMessageSendResult;
    ws?: RallarMessageSendResult;
    reason?: string;
}>;

export type RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot = TOutput> = Readonly<{
    roomId?: string;
    roomRef?: GroupRef;
    laneId?: string;
    topicId?: string;
    intentTypeId: string;
    outputTypeId: string;
    heartbeatTypeId?: string;
    snapshotTypeId?: string;
    syncRequestTypeId?: string;
    heartbeatIntervalMs?: number;
    snapshotIntervalMs?: number | false;
    readSnapshot?: () => TSnapshot | undefined | Promise<TSnapshot | undefined>;
    onIntent?: (
        message: RallarDirectorRelayMessage<TIntent>,
        relay: RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot>
    ) => void | TOutput | readonly TOutput[] | Promise<void | TOutput | readonly TOutput[]>;
    onOutput?: (
        message: RallarDirectorRelayMessage<TOutput>
    ) => void | Promise<void>;
    onSnapshot?: (
        message: RallarDirectorRelayMessage<TSnapshot>
    ) => void | Promise<void>;
    onSyncRequest?: (
        message: RallarDirectorRelayMessage<unknown>,
        relay: RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot>
    ) => void | Promise<void>;
}>;

export type RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot = TOutput> = Readonly<{
    status(): RallarDirectorStatus;
    sendIntent(intent: TIntent): Promise<RallarDirectorRelaySendResult>;
    sendOutput(output: TOutput): Promise<RallarDirectorRelaySendResult>;
    sendHeartbeat(): Promise<RallarDirectorRelaySendResult>;
    sendSnapshot(snapshot?: TSnapshot): Promise<RallarDirectorRelaySendResult>;
    requestSync(payload?: unknown): Promise<RallarDirectorRelaySendResult>;
    stop(): void;
}>;

export type RallarDirectorFacade = Readonly<{
    appoint(
        room?: string | GroupRef,
        options?: RallarDirectorAppointOptions
    ): Promise<RallarDirectorStatus>;
    resign(
        room?: string | GroupRef,
        options?: RallarDirectorResignOptions
    ): Promise<RallarDirectorStatus>;
    status(
        room?: string | GroupRef,
        options?: RallarDirectorStatusOptions
    ): RallarDirectorStatus;
    onStatus(listener: RallarDirectorStatusListener): RallarUnsubscribe;
    createRelay<TIntent, TOutput, TSnapshot = TOutput>(
        config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>
    ): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot>;
}>;

export type CreateRallarDirectorFacadeOptions = RallarDirectorFacade;

export function createRallarDirectorFacade(
    operations: CreateRallarDirectorFacadeOptions
): RallarDirectorFacade {
    return {
        appoint: async (
            room,
            options = {}
        ): Promise<RallarDirectorStatus> => await operations.appoint(room, options),
        resign: async (
            room,
            options = {}
        ): Promise<RallarDirectorStatus> => await operations.resign(room, options),
        status: (
            room,
            options = {}
        ): RallarDirectorStatus => operations.status(room, options),
        onStatus: (listener): RallarUnsubscribe => operations.onStatus(listener),
        createRelay: <TIntent, TOutput, TSnapshot = TOutput>(
            config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>
        ): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot> =>
            operations.createRelay<TIntent, TOutput, TSnapshot>(config)
    };
}
