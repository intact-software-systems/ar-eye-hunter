import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import {
    createDirectRallarRuntimeEvent,
    runDirectRallarWsSend,
    type DirectRallarOperationResult
} from '../../../direct-rallar-operations.ts';
import { completedActionFeedback, runningActionFeedback } from '../../../legacy/diagnostics/shared/action-feedback.ts';
import { redactedJson } from '../../../legacy/shared/redaction-presentation.ts';
import { rallarBlackBoxRuntimeStore, type RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { normalizeWebSocketJsonValue } from '../normalize-websocket-json-value.ts';
import type { RawWebSocketEventRecord } from '../raw/observe-raw-web-socket.ts';
import type { WebSocketCommandCenterState } from '../state/use-websocket-command-center-state.ts';
import { webSocketCommandCenterRecipe } from './websocket-recipes.ts';

export interface UseWebSocketEvidenceActionsInput {
    readonly state: RallarBlackBoxTestState;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly authSession: AuthSession | undefined;
    readonly commandCenter: WebSocketCommandCenterState;
}

export interface WebSocketDirectResultRecord {
    readonly result: DirectRallarOperationResult;
    readonly completedAction: string;
    readonly failedAction: string;
}

export interface WebSocketEvidenceActions {
    readonly directContext: () => Parameters<typeof runDirectRallarWsSend>[0];
    readonly recordEvent: (event: RawWebSocketEventRecord) => void;
    readonly recordDirectResult: (record: WebSocketDirectResultRecord) => void;
    readonly configure: () => Promise<void>;
    readonly copyDiagnostics: () => void;
    readonly copyRecipe: (includeRtcParity: boolean) => void;
}

export function useWebSocketEvidenceActions(
    input: UseWebSocketEvidenceActionsInput
): WebSocketEvidenceActions {
    const directContext = (): Parameters<typeof runDirectRallarWsSend>[0] => toDirectRallarContext(input);
    const recordEvent = (event: RawWebSocketEventRecord): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic: event.topic,
                context: directContext(),
                kind: event.kind ?? 'diagnostic',
                transport: 'ws',
                severity: event.severity ?? 'info',
                payload: event.payload
            }),
            event.lastAction
        );
    };
    const recordDirectResult = (record: WebSocketDirectResultRecord): void =>
        writeDirectResult(input.commandCenter, record, recordEvent);

    return {
        directContext,
        recordEvent,
        recordDirectResult,
        configure: () => configureWebSocket(input.commandCenter, recordEvent),
        copyDiagnostics: () => copyWebSocketDiagnostics(input),
        copyRecipe: (includeRtcParity) => copyWebSocketRecipe(input, includeRtcParity)
    };
}

function toDirectRallarContext(
    input: UseWebSocketEvidenceActionsInput
): Parameters<typeof runDirectRallarWsSend>[0] {
    const { providerMode, values } = input.commandCenter;
    return {
        providerMode,
        apiBaseUrl: values.apiBaseUrl,
        applicationId: values.applicationId,
        workspaceId: values.workspaceId,
        roomId: values.groupId.trim(),
        actor: input.authSession?.username ?? input.authSession?.clientId ?? input.bootstrap.actor,
        connection: values.connection,
        authSession: input.authSession,
        timeoutMs: values.timeoutMs
    };
}

function writeDirectResult(
    commandCenter: WebSocketCommandCenterState,
    record: WebSocketDirectResultRecord,
    recordEvent: WebSocketEvidenceActions['recordEvent']
): void {
    record.result.events.forEach((event) => rallarBlackBoxRuntimeStore.recordRuntimeEvent(event));
    const failed = record.result.status === 'failed';
    commandCenter.setLocalError(failed ? record.result.error?.message ?? record.failedAction : undefined);
    commandCenter.setWaitStatus(failed ? 'failed' : 'completed');
    recordEvent({
        topic: `rallar.direct.websocket.${record.result.kind}.${record.result.status}`,
        payload: normalizeWebSocketJsonValue({
            status: record.result.status,
            durationMs: record.result.durationMs,
            value: record.result.value,
            error: record.result.error
        }),
        lastAction: failed ? record.failedAction : record.completedAction,
        severity: failed ? 'error' : 'info',
        kind: 'state'
    });
}

async function configureWebSocket(
    commandCenter: WebSocketCommandCenterState,
    recordEvent: WebSocketEvidenceActions['recordEvent']
): Promise<void> {
    const label = 'Configure WebSocket';
    const startedAtEpochMs = Date.now();
    commandCenter.setBusyAction(label);
    commandCenter.setLocalError(undefined);
    commandCenter.setActionFeedback(runningActionFeedback(
        label,
        commandCenter.values.connection,
        'Recording the current WebSocket configuration.'
    ));
    try {
        commandCenter.setSequence((current) => current + 1);
        recordEvent({
            topic: 'rallar.direct.raw_ws.configure.completed',
            payload: {
                connection: commandCenter.values.connection,
                apiBaseUrl: commandCenter.values.apiBaseUrl,
                wsUrl: commandCenter.values.wsUrl,
                groupId: commandCenter.values.groupId,
                selector: { typeId: commandCenter.values.typeId, topicId: commandCenter.values.topicId }
            },
            lastAction: label
        });
        commandCenter.setWaitStatus('configured');
        commandCenter.setActionFeedback(completedActionFeedback({
            label,
            startedAtEpochMs,
            target: commandCenter.values.connection,
            ok: true,
            status: 'configured',
            message: `Configured ${commandCenter.routePreview.destination}.`
        }));
    }
    catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        completeEvidenceFailure({ commandCenter, label, startedAtEpochMs, cause });
    }
    finally {
        commandCenter.setBusyAction(undefined);
    }
}

interface CompleteEvidenceFailureInput {
    readonly commandCenter: WebSocketCommandCenterState;
    readonly label: string;
    readonly startedAtEpochMs: number;
    readonly cause: Error;
}

function completeEvidenceFailure(input: CompleteEvidenceFailureInput): void {
    const message = input.cause.message;
    input.commandCenter.setLocalError(message);
    input.commandCenter.setActionFeedback(completedActionFeedback({
        label: input.label,
        startedAtEpochMs: input.startedAtEpochMs,
        target: input.commandCenter.values.connection,
        ok: false,
        statusText: 'error',
        message
    }));
}

function copyWebSocketDiagnostics(input: UseWebSocketEvidenceActionsInput): void {
    const { commandCenter } = input;
    void navigator.clipboard?.writeText(redactedJson(
        {
            values: commandCenter.values,
            diagnostics: commandCenter.diagnostics,
            subscription: commandCenter.subscription
                ? {
                    label: commandCenter.subscription.label,
                    destination: commandCenter.subscription.destination,
                    groupId: commandCenter.subscription.groupId,
                    subscribedAtEpochMs: commandCenter.subscription.subscribedAtEpochMs
                }
                : undefined,
            ticket: commandCenter.ticket
                ? {
                    ...commandCenter.ticket,
                    ticket: '<redacted:ws-ticket>',
                    expiresInMs: commandCenter.ticket.expiresAtEpochMs - Date.now()
                }
                : undefined,
            waitStatus: commandCenter.waitStatus
        },
        input.state,
        input.authSession
    ));
}

function copyWebSocketRecipe(
    input: UseWebSocketEvidenceActionsInput,
    includeRtcParity: boolean
): void {
    if (!input.commandCenter.payloadResult.ok) {
        input.commandCenter.setLocalError(input.commandCenter.payloadResult.error);
        return;
    }
    void navigator.clipboard?.writeText(webSocketCommandCenterRecipe({
        values: input.commandCenter.values,
        payload: input.commandCenter.payloadResult.value,
        bootstrap: input.bootstrap,
        providerMode: input.commandCenter.providerMode,
        authSession: input.authSession,
        sequence: input.commandCenter.sequence,
        includeRtcParity
    }));
}
