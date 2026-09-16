import type {
    RallarBlackBoxTestEventKind,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import type { RallarBrowserStatusSummary } from '../../shell/rallar-browser-status.ts';

export interface UseWebSocketCommandCenterControllerInput {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    browserStatus: RallarBrowserStatusSummary;
}

export type WebSocketPayloadPreset = Readonly<{
    presetId: string;
    label: string;
    description: string;
    payload: RallarMessagePayload;
    values?: Partial<Pick<WebSocketCommandCenterValues, 'wsScope' | 'typeId' | 'topicId' | 'contextId'>>;
}>;

export type WebSocketRoutePreview = Readonly<{
    destination: string;
    destinationDetail: string;
    selector: string;
    selectorDetail: string;
    transport: string;
    transportDetail: string;
    sendLabel: string;
}>;

export type WebSocketCommandCenterValues = Readonly<{
    apiBaseUrl: string;
    connection: string;
    applicationId: string;
    workspaceId: string;
    groupId: string;
    wsScope: 'room' | 'all' | 'world';
    typeId: string;
    topicId: string;
    contextId: string;
    resourceId: string;
    wsUrl: string;
    protocols: string;
    payloadText: string;
    timeoutMs: number;
    closeCode: number;
    closeReason: string;
}>;

export type WebSocketEventRow = Readonly<{
    eventId: string;
    kind: RallarBlackBoxTestEventKind;
    topic: string;
    atEpochMs: number;
    severity: string;
    payload?: unknown;
}>;

export type WebSocketReceivedMessageRow = Readonly<{
    eventId: string;
    atEpochMs: number;
    senderId: string;
    roomId: string;
    typeId: string;
    topicId: string;
    contextId: string;
    resourceId: string;
    payload?: unknown;
}>;

export type WebSocketDiagnostic = Readonly<{
    readyState: string;
    status: 'idle' | 'open' | 'closed' | 'simulated' | 'error';
    statusLabel: string;
    lastOpenAtEpochMs?: number;
    lastCloseAtEpochMs?: number;
    closeCode?: unknown;
    closeReason?: unknown;
    inboundCount: number;
    outboundCount: number;
    errorCount: number;
    recentEvents: readonly WebSocketEventRow[];
    receivedMessages: readonly WebSocketReceivedMessageRow[];
}>;

export type WebSocketSubscriptionState = Readonly<{
    label: string;
    destination: string;
    groupId: string;
    subscribedAtEpochMs: number;
    unsubscribe(): void;
}>;
