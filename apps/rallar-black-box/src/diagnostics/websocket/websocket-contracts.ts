import type { RallarBlackBoxTestEventKind } from '@shared-test/rallar-bb-test/types.ts';

export interface WebSocketPayloadPreset {
    readonly presetId: string;
    readonly label: string;
    readonly description: string;
    readonly payload: WebSocketJsonValue;
    readonly values?: Partial<Pick<WebSocketCommandCenterValues, 'wsScope' | 'typeId' | 'topicId' | 'contextId'>>;
}

export interface WebSocketRoutePreview {
    readonly destination: string;
    readonly destinationDetail: string;
    readonly selector: string;
    readonly selectorDetail: string;
    readonly transport: string;
    readonly transportDetail: string;
    readonly sendLabel: string;
}

export interface WebSocketCommandCenterValues {
    readonly apiBaseUrl: string;
    readonly connection: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly groupId: string;
    readonly wsScope: 'room' | 'all' | 'world';
    readonly typeId: string;
    readonly topicId: string;
    readonly contextId: string;
    readonly resourceId: string;
    readonly wsUrl: string;
    readonly protocols: string;
    readonly payloadText: string;
    readonly timeoutMs: number;
    readonly closeCode: number;
    readonly closeReason: string;
}

export interface WebSocketEventRow {
    readonly eventId: string;
    readonly kind: RallarBlackBoxTestEventKind;
    readonly topic: string;
    readonly atEpochMs: number;
    readonly severity: string;
    readonly payload?: WebSocketJsonValue;
}

export interface WebSocketReceivedMessageRow {
    readonly eventId: string;
    readonly atEpochMs: number;
    readonly senderId: string;
    readonly roomId: string;
    readonly typeId: string;
    readonly topicId: string;
    readonly contextId: string;
    readonly resourceId: string;
    readonly payload?: WebSocketJsonValue;
}

export interface WebSocketCloseInfo {
    readonly closeCode?: number;
    readonly closeReason?: string;
}

export interface WebSocketDiagnostic extends WebSocketCloseInfo {
    readonly readyState: string;
    readonly status: 'idle' | 'open' | 'closed' | 'simulated' | 'error';
    readonly statusLabel: string;
    readonly lastOpenAtEpochMs?: number;
    readonly lastCloseAtEpochMs?: number;
    readonly inboundCount: number;
    readonly outboundCount: number;
    readonly errorCount: number;
    readonly recentEvents: readonly WebSocketEventRow[];
    readonly receivedMessages: readonly WebSocketReceivedMessageRow[];
}

export interface WebSocketSubscriptionState {
    readonly label: string;
    readonly destination: string;
    readonly groupId: string;
    readonly subscribedAtEpochMs: number;
    unsubscribe(): void;
}

export interface WebSocketPayloadParseSuccess {
    readonly ok: true;
    readonly value: WebSocketJsonValue;
}

export interface WebSocketPayloadParseFailure {
    readonly ok: false;
    readonly error: string;
}

export type WebSocketPayloadParseResult = WebSocketPayloadParseSuccess | WebSocketPayloadParseFailure;

export interface WebSocketJsonObject {
    readonly [key: string]: WebSocketJsonValue;
}

export type WebSocketJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly WebSocketJsonValue[]
    | WebSocketJsonObject;
