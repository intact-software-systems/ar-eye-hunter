import type {
    BlackBoxRallarAuthenticateDiagnostics,
    BlackBoxRallarCloseDiagnostics,
    BlackBoxRallarConnectDiagnostics,
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarCrdtRuntime,
    BlackBoxRallarDirectorRuntime,
    BlackBoxRallarHealthDiagnostics,
    BlackBoxRallarHealthInput,
    BlackBoxRallarSendDiagnostics,
    BlackBoxRallarSendInput,
    BlackBoxRallarWsSendDiagnostics
} from './contracts.ts';

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
    readonly ack?: string;
    readonly ownership?: BlackBoxRallarSendInput['ownership'];
}

export interface BlackBoxRallarRuntime {
    authenticate?(
        config: BlackBoxRallarConnectionConfig
    ): Promise<BlackBoxRallarAuthenticateDiagnostics>;
    connect(config: BlackBoxRallarConnectionConfig): Promise<BlackBoxRallarConnectDiagnostics>;
    send(input: BlackBoxRallarSendInput): Promise<BlackBoxRallarSendDiagnostics>;
    sendWs(input: BlackBoxRallarWsSendInput): Promise<BlackBoxRallarWsSendDiagnostics>;
    refreshRoom(options: BlackBoxRallarRoomRefreshOptions): Promise<void>;
    readonly crdt: BlackBoxRallarCrdtRuntime;
    readonly director: BlackBoxRallarDirectorRuntime;
    close(): Promise<BlackBoxRallarCloseDiagnostics>;
    health(input?: BlackBoxRallarHealthInput): Promise<BlackBoxRallarHealthDiagnostics>;
}
