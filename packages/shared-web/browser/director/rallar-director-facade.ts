import type {
    RallarMessagePayload,
    RallarMessageSendResult
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
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

export interface RallarDirectorStatus {
    readonly roomRef?: GroupRef;
    readonly roomId?: string;
    readonly role: RallarDirectorRole;
    readonly state: RallarDirectorState;
    readonly appointment?: RallarGroupDirectorAppointment;
    readonly isDirector: boolean;
    readonly isFresh: boolean;
    readonly active: boolean;
    readonly freshness: RallarGroupDirectorFreshness;
    readonly lastHeartbeatAtEpochMs?: number;
    readonly nowEpochMs: number;
}

export interface RallarDirectorAppointOptions extends RallarScopedOperationOptions {
    readonly heartbeatTtlMs?: number;
}

export interface RallarDirectorStatusOptions {
    readonly now?: number;
}

export type RallarDirectorStatusListener = (
    status: RallarDirectorStatus
) => void | Promise<void>;

export interface RallarDirectorRelayEnvelope<T = RallarMessagePayload> {
    readonly protocol: 'rallar.director.relay.v1';
    readonly topicId: string;
    readonly typeId: string;
    readonly roomId: string;
    readonly epoch: number;
    readonly sentAtEpochMs: number;
    readonly payload: T;
}

export interface RallarDirectorRelayMessage<T> {
    readonly transport: 'rtc' | 'ws';
    readonly senderId: string;
    readonly data: T;
    readonly envelope: RallarDirectorRelayEnvelope<T>;
    readonly receivedAtEpochMs: number;
}

export type RallarDirectorRelaySendStatus =
    | 'sent'
    | 'partial'
    | 'no-director'
    | 'not-director'
    | 'stale-director'
    | 'failed';

export interface RallarDirectorRelaySendResult {
    readonly status: RallarDirectorRelaySendStatus;
    readonly rtc?: RallarTargetedSendResult | RallarMessageSendResult;
    readonly ws?: RallarMessageSendResult;
    readonly reason?: string;
}

export interface RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot = TOutput> {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly laneId?: string;
    readonly topicId?: string;
    readonly intentTypeId: string;
    readonly outputTypeId: string;
    readonly heartbeatTypeId?: string;
    readonly snapshotTypeId?: string;
    readonly syncRequestTypeId?: string;
    readonly heartbeatIntervalMs?: number;
    readonly snapshotIntervalMs?: number | false;
    readonly readSnapshot?: () => TSnapshot | undefined | Promise<TSnapshot | undefined>;
    readonly onIntent?: (
        message: RallarDirectorRelayMessage<TIntent>,
        relay: RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot>
    ) => void | TOutput | readonly TOutput[] | Promise<void | TOutput | readonly TOutput[]>;
    readonly onOutput?: (message: RallarDirectorRelayMessage<TOutput>) => void | Promise<void>;
    readonly onSnapshot?: (message: RallarDirectorRelayMessage<TSnapshot>) => void | Promise<void>;
    readonly onSyncRequest?: (
        message: RallarDirectorRelayMessage<RallarMessagePayload>,
        relay: RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot>
    ) => void | Promise<void>;
}

export interface RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot = TOutput> {
    status(): RallarDirectorStatus;
    sendIntent(intent: TIntent): Promise<RallarDirectorRelaySendResult>;
    sendOutput(output: TOutput): Promise<RallarDirectorRelaySendResult>;
    sendHeartbeat(): Promise<RallarDirectorRelaySendResult>;
    sendSnapshot(snapshot?: TSnapshot): Promise<RallarDirectorRelaySendResult>;
    requestSync<TPayload>(payload?: TPayload): Promise<RallarDirectorRelaySendResult>;
    stop(): void;
}

export interface RallarDirectorFacade {
    appoint(room?: string | GroupRef, options?: RallarDirectorAppointOptions): Promise<RallarDirectorStatus>;
    resign(room?: string | GroupRef, options?: RallarScopedOperationOptions): Promise<RallarDirectorStatus>;
    status(room?: string | GroupRef, options?: RallarDirectorStatusOptions): RallarDirectorStatus;
    onStatus(listener: RallarDirectorStatusListener): RallarUnsubscribe;
    createRelay<TIntent, TOutput, TSnapshot = TOutput>(
        config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>
    ): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot>;
}
