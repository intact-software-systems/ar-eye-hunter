import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import type { CommandCenterGlobalValues } from '../../legacy/shell/global-context-model.ts';
import type { RallarBrowserStatusSummary } from '../../legacy/shell/rallar-browser-status.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../runtime-store.ts';
import {
    useWebSocketEvidenceActions,
    type WebSocketEvidenceActions
} from './evidence/use-websocket-evidence-actions.ts';
import { useRawWebSocketActions } from './raw/use-raw-websocket-actions.ts';
import {
    useWebSocketCommandCenterState,
    type WebSocketCommandCenterState
} from './state/use-websocket-command-center-state.ts';
import {
    useWebSocketTicketWaitActions,
    type WebSocketTicketActions
} from './ticket/use-websocket-ticket-wait-actions.ts';
import { useRallarWebSocketActions } from './use-rallar-websocket-actions.ts';
import type { WebSocketCommandCenterViewModel } from './view/web-socket-command-center-view-model.ts';

export interface UseWebSocketCommandCenterControllerInput {
    readonly state: RallarBlackBoxTestState;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly authSession?: AuthSession;
    readonly globalValues?: CommandCenterGlobalValues;
    readonly browserStatus: RallarBrowserStatusSummary;
}

interface WebSocketCommandCenterActionOwners {
    readonly commandCenter: WebSocketCommandCenterState;
    readonly evidence: WebSocketEvidenceActions;
    readonly ticket: WebSocketTicketActions;
    readonly raw: ReturnType<typeof useRawWebSocketActions>;
    readonly rallar: ReturnType<typeof useRallarWebSocketActions>;
}

export function useWebSocketCommandCenterController(
    input: UseWebSocketCommandCenterControllerInput
): WebSocketCommandCenterViewModel {
    const commandCenter = useWebSocketCommandCenterState({
        state: input.state,
        bootstrap: input.bootstrap,
        globalValues: input.globalValues,
        browserStatus: input.browserStatus
    });
    const evidence = useWebSocketEvidenceActions({
        state: input.state,
        bootstrap: input.bootstrap,
        authSession: input.authSession,
        commandCenter
    });
    const ticket = useWebSocketTicketWaitActions({
        bootstrap: input.bootstrap,
        authSession: input.authSession,
        commandCenter,
        recordEvent: evidence.recordEvent
    });
    const raw = useRawWebSocketActions({
        authSession: input.authSession,
        commandCenter,
        requestTicket: ticket.requestTicket,
        recordEvent: evidence.recordEvent
    });
    const rallar = useRallarWebSocketActions({
        commandCenter,
        directContext: evidence.directContext,
        recordEvent: evidence.recordEvent,
        recordDirectResult: evidence.recordDirectResult
    });
    return toWebSocketCommandCenterViewModel({ commandCenter, evidence, ticket, raw, rallar });
}

function toWebSocketCommandCenterViewModel(
    owners: WebSocketCommandCenterActionOwners
): WebSocketCommandCenterViewModel {
    const { commandCenter } = owners;
    const subscriptionStatusLabel = commandCenter.subscription ? 'listening' : 'not listening';
    const receiveStatusText = commandCenter.subscription
        ? `Listening for ${commandCenter.subscription.label} at ${commandCenter.subscription.destination}.`
        : commandCenter.providerMode === 'browser-rallar'
        ? 'Not listening. Click Subscribe WS to receive app messages in this browser.'
        : 'Received messages appear here when WS message events are emitted.';
    return {
        providerMode: commandCenter.providerMode,
        values: commandCenter.values,
        payloadPresetId: commandCenter.payloadPresetId,
        localError: commandCenter.localError,
        busyAction: commandCenter.busyAction,
        actionFeedback: commandCenter.actionFeedback,
        waitStatus: commandCenter.waitStatus,
        ticket: commandCenter.ticket,
        subscription: commandCenter.subscription,
        diagnostics: commandCenter.diagnostics,
        activePreset: commandCenter.activePreset,
        canSendViaRallarSignaling: commandCenter.providerMode === 'browser-rallar',
        routePreview: commandCenter.routePreview,
        subscriptionStatusLabel,
        subscriptionStatusTone: commandCenter.subscription ? 'good' : 'muted',
        receiveStatusText,
        payloadResult: commandCenter.payloadResult,
        updateValue: commandCenter.updateValue,
        updateGroupId: commandCenter.updateGroupId,
        updateWsScope: commandCenter.updateWsScope,
        selectPayloadPreset: commandCenter.selectPayloadPreset,
        configure: owners.evidence.configure,
        ...owners.raw,
        ...owners.rallar,
        createTicket: owners.ticket.createTicket,
        waitForMessage: owners.ticket.waitForMessage,
        waitForRallarWsOpen: owners.ticket.waitForRallarWsOpen,
        copyDiagnostics: owners.evidence.copyDiagnostics,
        copyRecipe: owners.evidence.copyRecipe
    };
}
