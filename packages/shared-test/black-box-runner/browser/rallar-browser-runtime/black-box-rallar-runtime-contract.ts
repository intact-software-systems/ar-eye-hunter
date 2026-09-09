import type { ALAckMode } from '@shared/al-contracts/al-contract.ts';
import type { ALNackPayload } from '@shared/al-contracts/al-control.ts';
import type { IndexedDbOperationCounts } from '@shared/persistence/indexed-db-operation-observer.ts';

import type {
    BlackBoxRallarAuthenticateDiagnostics,
    BlackBoxRallarCloseDiagnostics,
    BlackBoxRallarConnectDiagnostics,
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarCrdtRuntime,
    BlackBoxRallarDeliveryObservation,
    BlackBoxRallarDirectorRuntime,
    BlackBoxRallarFormationRuntime,
    BlackBoxRallarHealthDiagnostics,
    BlackBoxRallarHealthInput,
    BlackBoxRallarMessageSendDiagnostics,
    BlackBoxRallarSendDiagnostics,
    BlackBoxRallarSendInput,
    BlackBoxRallarWsSendDiagnostics
} from './black-box-rallar-operation-contracts.ts';

export interface BlackBoxRallarRoomRefreshOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
}

export interface BlackBoxRallarWsSendInput {
    readonly data?: BlackBoxRallarSendInput['data'];
    readonly payload?: BlackBoxRallarSendInput['payload'];
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
    connect(config: BlackBoxRallarConnectionConfig): Promise<BlackBoxRallarConnectDiagnostics>;
    send(input: unknown): Promise<BlackBoxRallarSendDiagnostics>;
    sendWs(input: unknown): Promise<BlackBoxRallarWsSendDiagnostics>;
    sendMessage(input: unknown): Promise<BlackBoxRallarMessageSendDiagnostics>;
    observeDelivery(input: unknown): Promise<BlackBoxRallarDeliveryObservation>;
    cancelDelivery(input: unknown): Promise<BlackBoxRallarDeliveryObservation>;
    readReceipts(input: unknown): Promise<BlackBoxRallarDeliveryObservation>;
    injectFault(input: unknown): Promise<void>;
    readStorageCounters(input: unknown): Promise<IndexedDbOperationCounts>;
    refreshRoom(options: BlackBoxRallarRoomRefreshOptions): Promise<void>;
    readRtcMessageNacks(messageId: string): Promise<readonly ALNackPayload[]>;
    readonly crdt: BlackBoxRallarCrdtRuntime;
    readonly director: BlackBoxRallarDirectorRuntime;
    readonly formation: BlackBoxRallarFormationRuntime;
    close(): Promise<BlackBoxRallarCloseDiagnostics>;
    health(input?: BlackBoxRallarHealthInput): Promise<BlackBoxRallarHealthDiagnostics>;
}
