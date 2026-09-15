import type { BlackBoxRallarEvent } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRtcSendCommand,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestTransport,
    RallarBlackBoxTestWsSendCommand
} from '../rallar-black-box-test-contracts.ts';
import type { CreateRallarBlackBoxTestRuntimeOptions } from '../runtime/create-rallar-black-box-test-runtime.ts';

export type RallarBlackBoxBrowserRallarTransport = Extract<
    RallarBlackBoxTestTransport,
    'realtime' | 'messages.rtc' | 'messages.ws'
>;

export interface RallarBlackBoxBrowserRallarConnectionConfig {
    readonly connection: string;
    readonly actor?: string;
    readonly peerId?: string;
    readonly remotePeerId?: string;
    readonly roomId?: string;
    readonly roomRef?: RallarBlackBoxTestRecord;
    readonly rallar: RallarBlackBoxTestRecord;
}

/** A page runtime result, recorded as the command value; the adapter decodes only the fields it reads. */
export type RallarBlackBoxBrowserRallarRuntimeResult = RallarBlackBoxTestCommandOutcome['value'];

export type RallarBlackBoxBrowserRallarRuntimeMethod = (
    input: RallarBlackBoxTestRecord
) => Promise<RallarBlackBoxBrowserRallarRuntimeResult>;

export interface RallarBlackBoxBrowserRallarCrdtRuntime {
    readonly open: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly apply: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly read: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly sync: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly health: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly wait: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly undo: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly redo: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly close: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly destroy: RallarBlackBoxBrowserRallarRuntimeMethod;
}

export interface RallarBlackBoxBrowserRallarFormationRuntime {
    readonly command: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly readiness: RallarBlackBoxBrowserRallarRuntimeMethod;
}

export interface RallarBlackBoxBrowserRallarDirectorRuntime {
    readonly appoint: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly resign: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly status: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly relayStart: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly intent: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly syncRequest: RallarBlackBoxBrowserRallarRuntimeMethod;
    readonly relayStop: RallarBlackBoxBrowserRallarRuntimeMethod;
}

export interface RallarBlackBoxBrowserRoomRefreshOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
}

/** A provider may omit a feature it does not run; the adapter then refuses the commands of that feature. */
export interface RallarBlackBoxBrowserRallarRuntime {
    authenticate(
        config: RallarBlackBoxBrowserRallarConnectionConfig
    ): Promise<RallarBlackBoxBrowserRallarRuntimeResult>;
    connect(
        config: RallarBlackBoxBrowserRallarConnectionConfig
    ): Promise<RallarBlackBoxBrowserRallarRuntimeResult>;
    send(input: RallarBlackBoxTestRtcSendCommand['send']): Promise<RallarBlackBoxBrowserRallarRuntimeResult>;
    sendWs?(input: RallarBlackBoxTestWsSendCommand['data']): Promise<RallarBlackBoxBrowserRallarRuntimeResult>;
    sendMessage: RallarBlackBoxBrowserRallarRuntimeMethod;
    observeDelivery: RallarBlackBoxBrowserRallarRuntimeMethod;
    cancelDelivery: RallarBlackBoxBrowserRallarRuntimeMethod;
    readReceipts: RallarBlackBoxBrowserRallarRuntimeMethod;
    injectFault: RallarBlackBoxBrowserRallarRuntimeMethod;
    readStorageCounters: RallarBlackBoxBrowserRallarRuntimeMethod;
    refreshRoom(
        options: RallarBlackBoxBrowserRoomRefreshOptions
    ): Promise<RallarBlackBoxBrowserRallarRuntimeResult>;
    waitForRoom: BlackBoxRallarRuntime['waitForRoom'];
    readonly crdt?: RallarBlackBoxBrowserRallarCrdtRuntime;
    readonly director?: RallarBlackBoxBrowserRallarDirectorRuntime;
    readonly formation?: RallarBlackBoxBrowserRallarFormationRuntime;
    close(): Promise<RallarBlackBoxBrowserRallarRuntimeResult>;
    health(input?: RallarBlackBoxTestRecord): Promise<RallarBlackBoxBrowserRallarRuntimeResult>;
}

/** Each field appears only when the forwarded page event carries it. */
export interface RallarBlackBoxBrowserRallarEvent {
    readonly kind?: 'diagnostic' | 'message' | 'close';
    readonly topic?: string;
    readonly connection?: string;
    readonly actor?: string;
    readonly transport?: RallarBlackBoxTestTransport;
    readonly severity?: 'debug' | 'info' | 'warning' | 'error';
    readonly atEpochMs?: number;
    readonly roomId?: string;
    readonly roomRef?: RallarBlackBoxTestRecord;
    readonly scope?: RallarBlackBoxTestRecord;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly laneId?: string;
    readonly peerId?: string;
    readonly remotePeerId?: string;
    readonly senderId?: string;
    readonly typeId?: string;
    readonly topicId?: string;
    readonly contextId?: string;
    readonly resourceId?: string;
    readonly data?: BlackBoxRallarEvent['data'];
    readonly error?: BlackBoxRallarEvent['error'];
}

export type RallarBlackBoxBrowserWebSocketData = string | ArrayBuffer | ArrayBufferView | Blob;

/** Each field is present only on the DOM event kinds that carry it; `type` keeps a DOM Event assignable. */
export interface RallarBlackBoxBrowserWebSocketEvent {
    readonly type?: string;
    readonly data?: RallarBlackBoxTestWsSendCommand['data'];
    readonly code?: number;
    readonly reason?: string;
    readonly wasClean?: boolean;
}

export type RallarBlackBoxBrowserWebSocketListener = (event: RallarBlackBoxBrowserWebSocketEvent) => void;

export interface RallarBlackBoxBrowserWebSocket {
    readonly readyState?: number;
    readonly protocol?: string;
    readonly url?: string;
    readonly bufferedAmount?: number;
    send(data: RallarBlackBoxBrowserWebSocketData): void;
    close(code?: number, reason?: string): void;
    addEventListener?: (type: string, listener: RallarBlackBoxBrowserWebSocketListener) => void;
    removeEventListener?: (type: string, listener: RallarBlackBoxBrowserWebSocketListener) => void;
    onopen?: RallarBlackBoxBrowserWebSocketListener | null;
    onmessage?: RallarBlackBoxBrowserWebSocketListener | null;
    onclose?: RallarBlackBoxBrowserWebSocketListener | null;
    onerror?: RallarBlackBoxBrowserWebSocketListener | null;
}

export type RallarBlackBoxBrowserWebSocketFactory = (
    url: string,
    protocols?: string | readonly string[]
) => RallarBlackBoxBrowserWebSocket;

export type RallarBlackBoxBrowserTestRuntime =
    & RallarBlackBoxTestRuntime
    & Readonly<{
        receiveRallarBrowserEvent(event: RallarBlackBoxBrowserRallarEvent): void;
    }>;

export type CreateRallarBlackBoxBrowserTestRuntimeOptions =
    & Omit<CreateRallarBlackBoxTestRuntimeOptions, 'commandExecutor'>
    & Readonly<{
        rallarRuntime?: RallarBlackBoxBrowserRallarRuntime;
        fetch?: typeof fetch;
        webSocketFactory?: RallarBlackBoxBrowserWebSocketFactory;
        defaultWsOpenTimeoutMs?: number;
        defaultHttpBodyLimit?: number;
    }>;

export type CommandWithId =
    & RallarBlackBoxTestCommand
    & Readonly<{ commandId: string; }>;

export type RallarBlackBoxBrowserRallarCrdtMethod = keyof RallarBlackBoxBrowserRallarCrdtRuntime;

export type RallarBlackBoxBrowserRallarDirectorMethod = keyof RallarBlackBoxBrowserRallarDirectorRuntime;

export interface WebSocketTicketResolution {
    readonly ticket: string;
    /** Present only when the ticket response names the session the ticket belongs to. */
    readonly sessionId?: string;
}
