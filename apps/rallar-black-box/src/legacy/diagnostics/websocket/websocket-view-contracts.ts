import type { CommandCenterActionFeedback } from '../shared/action-feedback.ts';
import type {
    WebSocketCommandCenterValues,
    WebSocketDiagnostic,
    WebSocketRoutePreview
} from './websocket-contracts.ts';

export type WebSocketCommandCenterViewModel = Readonly<{
    providerMode: 'simulated' | 'browser-rallar';
    values: WebSocketCommandCenterValues;
    payloadPresetId: string;
    localError?: string;
    busyAction?: string;
    actionFeedback: CommandCenterActionFeedback;
    waitStatus: string;
    ticket?: Readonly<{ expiresAtEpochMs: number; }>;
    subscription?: Readonly<{
        label: string;
        groupId: string;
        subscribedAtEpochMs: number;
    }>;
    diagnostics: WebSocketDiagnostic;
    activePreset: Readonly<{ label: string; description: string; }>;
    canSendViaRallarSignaling: boolean;
    routePreview: WebSocketRoutePreview;
    subscriptionStatusLabel: string;
    subscriptionStatusTone: 'good' | 'muted';
    receiveStatusText: string;
    payloadResult: Readonly<{ ok: true; } | { ok: false; error: string; }>;
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
}>;
