import type { CommandCenterActionFeedback } from '../../../legacy/diagnostics/shared/action-feedback.ts';
import type { AuthCommandCenterTicket } from '../../../legacy/diagnostics/shared/auth-command-center-ticket.ts';
import type {
    WebSocketCommandCenterValues,
    WebSocketDiagnostic,
    WebSocketPayloadParseResult,
    WebSocketPayloadPreset,
    WebSocketRoutePreview,
    WebSocketSubscriptionState
} from '../websocket-contracts.ts';

export interface WebSocketCommandCenterViewModel {
    readonly providerMode: 'simulated' | 'browser-rallar';
    readonly values: WebSocketCommandCenterValues;
    readonly payloadPresetId: string;
    readonly localError?: string;
    readonly busyAction?: string;
    readonly actionFeedback: CommandCenterActionFeedback;
    readonly waitStatus: string;
    readonly ticket?: Pick<AuthCommandCenterTicket, 'expiresAtEpochMs'>;
    readonly subscription?: Pick<WebSocketSubscriptionState, 'label' | 'groupId' | 'subscribedAtEpochMs'>;
    readonly diagnostics: WebSocketDiagnostic;
    readonly activePreset: Pick<WebSocketPayloadPreset, 'label' | 'description'>;
    readonly canSendViaRallarSignaling: boolean;
    readonly routePreview: WebSocketRoutePreview;
    readonly subscriptionStatusLabel: string;
    readonly subscriptionStatusTone: 'good' | 'muted';
    readonly receiveStatusText: string;
    readonly payloadResult: WebSocketPayloadParseResult;
    updateValue<K extends keyof WebSocketCommandCenterValues>(
        key: K,
        value: WebSocketCommandCenterValues[K]
    ): void;
    updateGroupId(groupId: string): void;
    updateWsScope(
        wsScope: WebSocketCommandCenterValues['wsScope']
    ): void;
    selectPayloadPreset(presetId: string): void;
    configure(): Promise<void>;
    open(url?: string): Promise<void>;
    send(): Promise<void>;
    close(reason?: string): Promise<void>;
    reconnect(): Promise<void>;
    cleanup(): Promise<void>;
    subscribeWs(): Promise<void>;
    unsubscribeWs(): void;
    createTicket(): Promise<void>;
    waitForMessage(): Promise<void>;
    waitForRallarWsOpen(): Promise<void>;
    copyDiagnostics(): void;
    copyRecipe(includeRtcParity: boolean): void;
    openMissingTicket(): Promise<void>;
}
