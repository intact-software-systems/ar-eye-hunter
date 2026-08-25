import { runDirectRallarWsSend, runDirectRallarWsSubscribe } from '../../direct-rallar-operations.ts';
import { completedActionFeedback, runningActionFeedback } from '../../legacy/diagnostics/shared/action-feedback.ts';
import { loadBrowserRallarFacade } from '../../legacy/rallar/load-browser-rallar-facade.ts';
import type { WebSocketEvidenceActions } from './evidence/use-websocket-evidence-actions.ts';
import { isWebSocketJsonObject, normalizeWebSocketJsonValue } from './normalize-websocket-json-value.ts';
import type { RawWebSocketEventRecord } from './raw/observe-raw-web-socket.ts';
import type { WebSocketCommandCenterState } from './state/use-websocket-command-center-state.ts';
import type { WebSocketJsonValue } from './websocket-contracts.ts';

export interface UseRallarWebSocketActionsInput {
    readonly commandCenter: WebSocketCommandCenterState;
    readonly directContext: WebSocketEvidenceActions['directContext'];
    readonly recordEvent: (event: RawWebSocketEventRecord) => void;
    readonly recordDirectResult: WebSocketEvidenceActions['recordDirectResult'];
}

export interface RallarWebSocketActions {
    readonly send: () => Promise<void>;
    readonly subscribeWs: () => Promise<void>;
    readonly unsubscribeWs: () => void;
}

export function useRallarWebSocketActions(input: UseRallarWebSocketActionsInput): RallarWebSocketActions {
    return {
        send: () => sendRallarWebSocketMessage(input),
        subscribeWs: () => subscribeRallarWebSocket(input),
        unsubscribeWs: () => unsubscribeRallarWebSocket(input.commandCenter)
    };
}

async function sendRallarWebSocketMessage(input: UseRallarWebSocketActionsInput): Promise<void> {
    const validationMessage = resolveWebSocketSendValidationMessage(input.commandCenter);
    if (validationMessage) {
        completeInvalidRallarAction(input.commandCenter, 'Send WebSocket JSON', validationMessage);
        return;
    }
    const label = 'Send WebSocket JSON';
    const startedAtEpochMs = Date.now();
    startRallarAction(
        input.commandCenter,
        label,
        `Sending ${input.commandCenter.routePreview.selector} through Rallar WS messages.`
    );
    try {
        const result = await runDirectRallarWsSend(
            input.directContext(),
            toDirectWebSocketSend(input.commandCenter),
            loadBrowserRallarFacade
        );
        input.commandCenter.setSequence((current) => current + 1);
        input.recordDirectResult({
            result,
            completedAction: 'Rallar WS JSON sent',
            failedAction: 'Rallar WS send failed'
        });
        input.commandCenter.setActionFeedback(completedActionFeedback({
            label,
            startedAtEpochMs,
            target: input.commandCenter.routePreview.destination,
            ok: result.status === 'completed',
            status: result.status,
            durationMs: result.durationMs,
            message: result.status === 'completed'
                ? `Sent ${input.commandCenter.routePreview.selector}.`
                : result.error?.message ?? 'Rallar WS send failed.'
        }));
    }
    catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        completeRallarActionFailure({
            commandCenter: input.commandCenter,
            label,
            startedAtEpochMs,
            cause
        });
    }
    finally {
        input.commandCenter.setBusyAction(undefined);
    }
}

function toDirectWebSocketSend(
    commandCenter: WebSocketCommandCenterState
): Parameters<typeof runDirectRallarWsSend>[1] {
    if (!commandCenter.payloadResult.ok) {
        throw new Error(commandCenter.payloadResult.error);
    }
    const { values } = commandCenter;
    return {
        scope: values.wsScope,
        typeId: values.typeId,
        topicId: values.topicId,
        contextId: values.contextId,
        resourceId: values.resourceId || undefined,
        payload: commandCenter.payloadResult.value
    };
}

async function subscribeRallarWebSocket(input: UseRallarWebSocketActionsInput): Promise<void> {
    const validationMessage = resolveWebSocketSubscribeValidationMessage(input.commandCenter);
    if (validationMessage) {
        completeInvalidRallarAction(input.commandCenter, 'Subscribe WS', validationMessage);
        return;
    }
    const label = 'Subscribe WS';
    const startedAtEpochMs = Date.now();
    startRallarAction(input.commandCenter, label, `Subscribing to ${input.commandCenter.routePreview.selector}.`);
    try {
        input.commandCenter.subscription?.unsubscribe();
        const selector = toWebSocketSelector(input.commandCenter);
        const result = await runDirectRallarWsSubscribe(
            input.directContext(),
            {
                selector,
                handler: (message) =>
                    recordRallarWebSocketMessage(
                        input,
                        normalizeWebSocketJsonValue(message)
                    )
            },
            loadBrowserRallarFacade
        );
        completeRallarWebSocketSubscription({ ...input, selector, result, label, startedAtEpochMs });
    }
    catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        completeRallarActionFailure({
            commandCenter: input.commandCenter,
            label,
            startedAtEpochMs,
            cause
        });
    }
    finally {
        input.commandCenter.setBusyAction(undefined);
    }
}

function recordRallarWebSocketMessage(
    input: UseRallarWebSocketActionsInput,
    message: WebSocketJsonValue
): void {
    const record = isWebSocketJsonObject(message) ? message : {};
    const { values } = input.commandCenter;
    input.recordEvent({
        topic: 'rallar.direct.ws.message',
        payload: {
            roomId: record.roomId ?? record.groupId ?? values.groupId,
            applicationId: values.applicationId,
            workspaceId: values.workspaceId,
            typeId: record.typeId ?? values.typeId,
            topicId: record.topicId ?? values.topicId,
            contextId: record.contextId ?? values.contextId,
            resourceId: record.resourceId,
            senderId: record.senderId,
            data: record.payload ?? message,
            raw: message
        },
        lastAction: 'Rallar WS message received',
        severity: 'info',
        kind: 'message'
    });
}

interface WebSocketSelector {
    readonly typeId: string;
    readonly topicId?: string;
}

function toWebSocketSelector(commandCenter: WebSocketCommandCenterState): WebSocketSelector {
    return {
        typeId: commandCenter.values.typeId,
        ...(commandCenter.values.topicId ? { topicId: commandCenter.values.topicId } : {})
    };
}

interface CompleteWebSocketSubscriptionInput extends UseRallarWebSocketActionsInput {
    readonly selector: WebSocketSelector;
    readonly result: Awaited<ReturnType<typeof runDirectRallarWsSubscribe>>;
    readonly label: string;
    readonly startedAtEpochMs: number;
}

function completeRallarWebSocketSubscription(input: CompleteWebSocketSubscriptionInput): void {
    const { result, selector, label, startedAtEpochMs } = input;
    input.recordDirectResult({
        result,
        completedAction: 'Rallar WS subscribed',
        failedAction: 'Rallar WS subscribe failed'
    });
    if (result.status === 'completed' && result.unsubscribe) {
        input.commandCenter.setSubscription({
            label: `${selector.topicId ?? '*'} / ${selector.typeId}`,
            destination: input.commandCenter.routePreview.destination,
            groupId: input.commandCenter.values.groupId,
            subscribedAtEpochMs: Date.now(),
            unsubscribe: result.unsubscribe
        });
        input.commandCenter.setWaitStatus('subscribed');
    }
    input.commandCenter.setActionFeedback(completedActionFeedback({
        label,
        startedAtEpochMs,
        target: input.commandCenter.routePreview.destination,
        ok: result.status === 'completed',
        status: result.status,
        durationMs: result.durationMs,
        message: result.status === 'completed'
            ? `Subscribed to ${selector.topicId ?? '*'} / ${selector.typeId}.`
            : result.error?.message ?? 'Rallar WS subscribe failed.'
    }));
}

function unsubscribeRallarWebSocket(commandCenter: WebSocketCommandCenterState): void {
    const startedAtEpochMs = Date.now();
    commandCenter.subscription?.unsubscribe();
    commandCenter.setSubscription(undefined);
    commandCenter.setWaitStatus('unsubscribed');
    commandCenter.setActionFeedback(completedActionFeedback({
        label: 'Unsubscribe WS',
        startedAtEpochMs,
        target: commandCenter.subscription?.destination ?? commandCenter.routePreview.destination,
        ok: true,
        status: commandCenter.subscription ? 'unsubscribed' : 'no subscription',
        message: commandCenter.subscription
            ? 'Rallar WS subscription cleared.'
            : 'No Rallar WS subscription was active.'
    }));
}

function resolveWebSocketSendValidationMessage(commandCenter: WebSocketCommandCenterState): string | undefined {
    if (!commandCenter.payloadResult.ok) {
        return commandCenter.payloadResult.error;
    }
    return commandCenter.values.wsScope === 'room' && !commandCenter.values.groupId.trim()
        ? 'Room-scoped WS sends require a Group.'
        : undefined;
}

function resolveWebSocketSubscribeValidationMessage(commandCenter: WebSocketCommandCenterState): string | undefined {
    if (!commandCenter.values.typeId.trim()) {
        return 'WS subscription requires a Type ID.';
    }
    return commandCenter.values.wsScope === 'room' && !commandCenter.values.groupId.trim()
        ? 'Room-scoped WS subscriptions require a Group.'
        : undefined;
}

function startRallarAction(
    commandCenter: WebSocketCommandCenterState,
    label: string,
    message: string
): void {
    commandCenter.setBusyAction(label);
    commandCenter.setLocalError(undefined);
    commandCenter.setActionFeedback(runningActionFeedback(
        label,
        commandCenter.routePreview.destination,
        message
    ));
}

function completeInvalidRallarAction(
    commandCenter: WebSocketCommandCenterState,
    label: string,
    message: string
): void {
    commandCenter.setLocalError(message);
    commandCenter.setActionFeedback(completedActionFeedback({
        label,
        startedAtEpochMs: Date.now(),
        target: commandCenter.routePreview.destination,
        ok: false,
        statusText: label === 'Subscribe WS' ? 'invalid selector' : 'invalid payload',
        message
    }));
}

interface CompleteRallarActionFailureInput {
    readonly commandCenter: WebSocketCommandCenterState;
    readonly label: string;
    readonly startedAtEpochMs: number;
    readonly cause: Error;
}

function completeRallarActionFailure(input: CompleteRallarActionFailureInput): void {
    const message = input.cause.message;
    input.commandCenter.setLocalError(message);
    input.commandCenter.setActionFeedback(completedActionFeedback({
        label: input.label,
        startedAtEpochMs: input.startedAtEpochMs,
        target: input.commandCenter.routePreview.destination,
        ok: false,
        statusText: 'error',
        message
    }));
}
