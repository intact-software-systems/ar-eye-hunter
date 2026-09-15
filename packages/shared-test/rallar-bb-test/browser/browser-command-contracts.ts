import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestTransport
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
    readonly roomRef?: Readonly<Record<string, unknown>>;
    readonly rallar: Readonly<Record<string, unknown>>;
}

export type RallarBlackBoxBrowserRallarRuntimeMethod = (
    input: unknown
) => Promise<unknown>;

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

export interface RallarBlackBoxBrowserRallarRuntime {
    authenticate(
        config: RallarBlackBoxBrowserRallarConnectionConfig
    ): Promise<unknown>;
    connect(
        config: RallarBlackBoxBrowserRallarConnectionConfig
    ): Promise<unknown>;
    send: RallarBlackBoxBrowserRallarRuntimeMethod;
    sendWs?: RallarBlackBoxBrowserRallarRuntimeMethod;
    sendMessage: RallarBlackBoxBrowserRallarRuntimeMethod;
    observeDelivery: RallarBlackBoxBrowserRallarRuntimeMethod;
    cancelDelivery: RallarBlackBoxBrowserRallarRuntimeMethod;
    readReceipts: RallarBlackBoxBrowserRallarRuntimeMethod;
    injectFault: RallarBlackBoxBrowserRallarRuntimeMethod;
    readStorageCounters: RallarBlackBoxBrowserRallarRuntimeMethod;
    refreshRoom(
        options: RallarBlackBoxBrowserRoomRefreshOptions
    ): Promise<unknown>;
    waitForRoom: BlackBoxRallarRuntime['waitForRoom'];
    readonly crdt?: RallarBlackBoxBrowserRallarCrdtRuntime;
    readonly director?: RallarBlackBoxBrowserRallarDirectorRuntime;
    readonly formation?: RallarBlackBoxBrowserRallarFormationRuntime;
    close(): Promise<unknown>;
    health(input?: unknown): Promise<unknown>;
}

export interface RallarBlackBoxBrowserRallarEvent {
    readonly kind?: 'diagnostic' | 'message' | 'close';
    readonly topic?: string;
    readonly connection?: string;
    readonly actor?: string;
    readonly transport?: RallarBlackBoxTestTransport;
    readonly severity?: 'debug' | 'info' | 'warning' | 'error';
    readonly atEpochMs?: number;
    readonly roomId?: string;
    readonly roomRef?: Readonly<Record<string, unknown>>;
    readonly scope?: Readonly<Record<string, unknown>>;
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
    readonly data?: unknown;
    readonly error?: unknown;
    [key: string]: unknown;
}

export interface RallarBlackBoxBrowserWebSocket {
    readonly readyState?: number;
    readonly protocol?: string;
    readonly url?: string;
    readonly bufferedAmount?: number;
    send(data: unknown): void;
    close(code?: number, reason?: string): void;
    addEventListener?: (type: string, listener: (event: unknown) => void) => void;
    removeEventListener?: (
        type: string,
        listener: (event: unknown) => void
    ) => void;
    onopen?: ((event: unknown) => void) | null;
    onmessage?: ((event: unknown) => void) | null;
    onclose?: ((event: unknown) => void) | null;
    onerror?: ((event: unknown) => void) | null;
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

export interface HttpResponseOptions {
    readonly body?: HttpBodyMode;
    readonly maxBodyChars?: number;
    readonly acceptedStatusCodes?: readonly number[];
}

export type HttpBodyMode = 'none' | 'text' | 'json';

export interface WebSocketTicketResolution {
    readonly ticket: string;
    readonly sessionId?: string;
}

export interface RtcSendFailure {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
}

export interface RtcSendObservationInput {
    readonly command: Extract<CommandWithId, { kind: 'rtc.send'; }>;
    readonly diagnostics: object;
    readonly durationMs: number;
    readonly ok: boolean;
    readonly errorCode?: string;
}
