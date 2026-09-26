import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarRoomTransportStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { ALAckMode } from '@shared/al-contracts/al-contract.ts';
import type { ALNackPayload } from '@shared/al-contracts/al-control.ts';
import type { IndexedDbOperationCounts } from '@shared/persistence/indexed-db-operation-observer.ts';

import type {
    BlackBoxRallarAuthenticateDiagnostics,
    BlackBoxRallarCloseDiagnostics,
    BlackBoxRallarConnectDiagnostics,
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarControlSubmitDiagnostics,
    BlackBoxRallarCrdtRuntime,
    BlackBoxRallarDeliveryObservation,
    BlackBoxRallarDirectorRuntime,
    BlackBoxRallarFormationRuntime,
    BlackBoxRallarHealthDiagnostics,
    BlackBoxRallarHealthInput,
    BlackBoxRallarMessageReplayDiagnostics,
    BlackBoxRallarMessageSendDiagnostics,
    BlackBoxRallarSendDiagnostics,
    BlackBoxRallarSendInput,
    BlackBoxRallarWsSendDiagnostics
} from './black-box-rallar-operation-contracts.ts';

export interface BlackBoxRallarRoomRefreshOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
}

export interface BlackBoxRallarRoomWaitOptions {
    readonly connect: boolean;
    readonly minReadyPeers: number;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
}

/** The payload is resolved while decoding: the named payload or data, otherwise the whole send. */
export interface BlackBoxRallarWsSendInput {
    readonly payload: RallarMessagePayload;
    readonly scope?: 'room' | 'world' | 'all';
    readonly roomId?: string;
    readonly groupId?: string;
    readonly roomRef?: BlackBoxRallarSendInput['roomRef'];
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly typeId?: string;
    readonly topicId?: string;
    readonly topic?: string;
    readonly kind?: string;
    readonly contextId?: string;
    readonly resourceId?: string;
    readonly minSnapshotVersion?: number;
    readonly exceptPeerIds?: readonly string[];
    readonly ttlHops?: number;
    readonly ttlMs?: number;
    readonly reliability?: BlackBoxRallarSendInput['reliability'];
    readonly ack?: ALAckMode;
    readonly ownership?: BlackBoxRallarSendInput['ownership'];
}

export interface BlackBoxRallarRuntime {
    authenticate(
        config: BlackBoxRallarConnectionConfig
    ): Promise<BlackBoxRallarAuthenticateDiagnostics>;
    connect(
        config: BlackBoxRallarConnectionConfig
    ): Promise<BlackBoxRallarConnectDiagnostics>;
    /** An absent deadline gives typed-message admission its default wait budget; realtime sends ignore it. */
    send(input: unknown, deadlineEpochMs?: number): Promise<BlackBoxRallarSendDiagnostics>;
    sendWs(input: unknown): Promise<BlackBoxRallarWsSendDiagnostics>;
    sendMessage(
        input: unknown
    ): Promise<BlackBoxRallarMessageSendDiagnostics | BlackBoxRallarMessageReplayDiagnostics>;
    observeDelivery(input: unknown): Promise<BlackBoxRallarDeliveryObservation>;
    cancelDelivery(input: unknown): Promise<BlackBoxRallarDeliveryObservation>;
    readReceipts(input: unknown): Promise<BlackBoxRallarDeliveryObservation>;
    submitControl(input: unknown): Promise<BlackBoxRallarControlSubmitDiagnostics>;
    injectFault(input: unknown): Promise<void>;
    readStorageCounters(input: unknown): Promise<IndexedDbOperationCounts>;
    refreshRoom(options: BlackBoxRallarRoomRefreshOptions): Promise<void>;
    waitForRoom(
        options: BlackBoxRallarRoomWaitOptions
    ): Promise<RallarRoomTransportStatus>;
    readRtcMessageNacks(messageId: string): Promise<readonly ALNackPayload[]>;
    readonly crdt: BlackBoxRallarCrdtRuntime;
    readonly director: BlackBoxRallarDirectorRuntime;
    readonly formation: BlackBoxRallarFormationRuntime;
    close(): Promise<BlackBoxRallarCloseDiagnostics>;
    health(
        input?: BlackBoxRallarHealthInput
    ): Promise<BlackBoxRallarHealthDiagnostics>;
}
