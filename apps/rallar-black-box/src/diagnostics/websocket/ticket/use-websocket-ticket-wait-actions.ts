import type { RallarWsWaitForOpenResult } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { createDirectRallarRuntimeEvent } from '../../../direct-rallar-operations.ts';
import { completedActionFeedback, runningActionFeedback } from '../../../legacy/diagnostics/shared/action-feedback.ts';
import type { AuthCommandCenterTicket } from '../../../legacy/diagnostics/shared/auth-command-center-ticket.ts';
import { loadBrowserRallarFacade } from '../../../legacy/rallar/load-browser-rallar-facade.ts';
import { formatDuration, formatTime } from '../../../legacy/shared/time-format.ts';
import { rallarBlackBoxRuntimeStore, type RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { RawWebSocketEventRecord } from '../raw/observe-raw-web-socket.ts';
import { deriveWebSocketDiagnostics } from '../state/derive-web-socket-diagnostics.ts';
import type { WebSocketCommandCenterState } from '../state/use-websocket-command-center-state.ts';
import { requestWebSocketTicket } from './request-web-socket-ticket.ts';

export interface UseWebSocketTicketActionsInput {
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly authSession: AuthSession | undefined;
    readonly commandCenter: WebSocketCommandCenterState;
    readonly recordEvent: (event: RawWebSocketEventRecord) => void;
}

export interface WebSocketTicketActions {
    readonly requestTicket: (requestId: string) => Promise<AuthCommandCenterTicket>;
    readonly createTicket: () => Promise<void>;
    readonly waitForMessage: () => Promise<void>;
    readonly waitForRallarWsOpen: () => Promise<void>;
}

export function useWebSocketTicketWaitActions(
    input: UseWebSocketTicketActionsInput
): WebSocketTicketActions {
    const requestTicket = async (requestId: string): Promise<AuthCommandCenterTicket> => {
        const ticket = await requestWebSocketTicket({
            apiBaseUrl: input.commandCenter.values.apiBaseUrl,
            authSession: input.authSession,
            requestId,
            timeoutMs: input.commandCenter.values.timeoutMs
        });
        input.commandCenter.setTicket(ticket);
        return ticket;
    };
    return {
        requestTicket,
        createTicket: () => createWebSocketTicket(input, requestTicket),
        waitForMessage: () => waitForWebSocketMessage(input.commandCenter),
        waitForRallarWsOpen: () => waitForRallarWebSocketOpen(input)
    };
}

async function createWebSocketTicket(
    input: UseWebSocketTicketActionsInput,
    requestTicket: WebSocketTicketActions['requestTicket']
): Promise<void> {
    const label = 'Create WS ticket';
    const startedAtEpochMs = Date.now();
    input.commandCenter.setBusyAction(label);
    input.commandCenter.setLocalError(undefined);
    input.commandCenter.setActionFeedback(
        runningActionFeedback(label, '/api/auth/ws-ticket', 'Requesting a WebSocket ticket.')
    );
    try {
        const ticket = await requestTicket(crypto.randomUUID());
        input.recordEvent({
            topic: 'rallar.direct.raw_ws.ticket.created',
            payload: {
                sessionId: ticket.sessionId,
                expiresAtEpochMs: ticket.expiresAtEpochMs,
                ticket: '<redacted:ws-ticket>'
            },
            lastAction: label
        });
        input.commandCenter.setActionFeedback(completedActionFeedback({
            label,
            startedAtEpochMs,
            target: '/api/auth/ws-ticket',
            ok: true,
            status: 'created',
            message: `Ticket expires at ${formatTime(ticket.expiresAtEpochMs)}.`
        }));
    }
    catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        completeTicketWaitFailure({
            commandCenter: input.commandCenter,
            label,
            startedAtEpochMs,
            target: '/api/auth/ws-ticket',
            cause
        });
    }
    finally {
        input.commandCenter.setBusyAction(undefined);
    }
}

async function waitForWebSocketMessage(commandCenter: WebSocketCommandCenterState): Promise<void> {
    const startedAtEpochMs = Date.now();
    const label = 'Wait for WS message';
    commandCenter.setWaitStatus('waiting');
    commandCenter.setBusyAction(label);
    commandCenter.setLocalError(undefined);
    commandCenter.setActionFeedback(runningActionFeedback(
        label,
        commandCenter.values.connection,
        `Waiting up to ${formatDuration(commandCenter.values.timeoutMs)} for inbound WS traffic.`
    ));
    try {
        await waitForInboundMessage(commandCenter, startedAtEpochMs);
        commandCenter.setWaitStatus('message observed');
        commandCenter.setActionFeedback(completedActionFeedback({
            label,
            startedAtEpochMs,
            target: commandCenter.values.connection,
            ok: true,
            status: 'observed',
            message: 'A WebSocket message was observed.'
        }));
    }
    catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        commandCenter.setWaitStatus('timeout');
        completeTicketWaitFailure({
            commandCenter,
            label,
            startedAtEpochMs,
            target: commandCenter.values.connection,
            cause,
            statusText: 'timeout'
        });
    }
    finally {
        commandCenter.setBusyAction(undefined);
    }
}

function waitForInboundMessage(
    commandCenter: WebSocketCommandCenterState,
    startedAtEpochMs: number
): Promise<void> {
    const initialCount = commandCenter.diagnostics.inboundCount;
    return new Promise<void>((resolve, reject) => {
        const interval = window.setInterval(() => {
            const latest = deriveWebSocketDiagnostics(commandCenter.stateRef.current, commandCenter.values.connection);
            if (latest.inboundCount > initialCount) {
                window.clearInterval(interval);
                resolve();
                return;
            }
            if (Date.now() - startedAtEpochMs > commandCenter.values.timeoutMs) {
                window.clearInterval(interval);
                reject(new Error('Timed out waiting for WebSocket message.'));
            }
        }, 100);
    });
}

async function waitForRallarWebSocketOpen(input: UseWebSocketTicketActionsInput): Promise<void> {
    const label = 'Wait for Rallar WS open';
    const startedAtEpochMs = Date.now();
    input.commandCenter.setBusyAction(label);
    input.commandCenter.setLocalError(undefined);
    input.commandCenter.setActionFeedback(runningActionFeedback(
        label,
        input.commandCenter.values.apiBaseUrl,
        'Starting Rallar signaling and waiting for WS open.'
    ));
    try {
        validateRallarWebSocketWait(input);
        const result = await readRallarWebSocketOpen(input.commandCenter);
        recordRallarWebSocketWait({ ...input, result, label, startedAtEpochMs });
    }
    catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        input.commandCenter.setWaitStatus('rallar ws wait failed');
        completeTicketWaitFailure({
            commandCenter: input.commandCenter,
            label,
            startedAtEpochMs,
            target: input.commandCenter.values.apiBaseUrl,
            cause
        });
    }
    finally {
        input.commandCenter.setBusyAction(undefined);
    }
}

function validateRallarWebSocketWait(input: UseWebSocketTicketActionsInput): void {
    if (input.commandCenter.providerMode !== 'browser-rallar') {
        throw new Error('Rallar WS wait requires provider=browser-rallar.');
    }
    if (!input.authSession) {
        throw new Error('Rallar WS wait requires a logged-in browser session.');
    }
}

async function readRallarWebSocketOpen(
    commandCenter: WebSocketCommandCenterState
): Promise<RallarWsWaitForOpenResult> {
    const facade = await loadBrowserRallarFacade();
    const { values } = commandCenter;
    facade.configure({ apiBaseUrl: values.apiBaseUrl });
    facade.setDefaults({
        applicationId: values.applicationId,
        workspaceId: values.workspaceId,
        room: values.groupId
            ? {
                roomId: values.groupId,
                roomRef: {
                    applicationId: values.applicationId,
                    workspaceId: values.workspaceId,
                    groupId: values.groupId
                }
            }
            : undefined
    });
    await facade.start({ connect: true, refreshRooms: false, refreshPeople: false, timeoutMs: values.timeoutMs });
    return facade.ws.waitForOpen({ timeoutMs: values.timeoutMs });
}

interface RecordRallarWebSocketWaitInput extends UseWebSocketTicketActionsInput {
    readonly result: RallarWsWaitForOpenResult;
    readonly label: string;
    readonly startedAtEpochMs: number;
}

function recordRallarWebSocketWait(input: RecordRallarWebSocketWaitInput): void {
    const open = input.result.status === 'open';
    rallarBlackBoxRuntimeStore.recordRuntimeEvent(
        createDirectRallarRuntimeEvent({
            topic: open ? 'rallar.direct.ws.wait_open.completed' : 'rallar.direct.ws.wait_open.failed',
            context: toRallarWebSocketWaitContext(input),
            transport: 'ws',
            severity: open ? 'info' : 'error',
            payload: input.result
        }),
        open ? 'Rallar WS open observed' : 'Rallar WS open wait failed'
    );
    input.commandCenter.setWaitStatus(open ? 'rallar ws open' : input.result.status);
    input.commandCenter.setActionFeedback(completedActionFeedback({
        label: input.label,
        startedAtEpochMs: input.startedAtEpochMs,
        target: input.commandCenter.values.apiBaseUrl,
        ok: open,
        status: input.result.status,
        message: open ? 'Rallar signaling WebSocket is open.' : 'Rallar signaling WebSocket did not open.'
    }));
}

function toRallarWebSocketWaitContext(
    input: UseWebSocketTicketActionsInput
): Parameters<typeof createDirectRallarRuntimeEvent>[0]['context'] {
    const { values, providerMode } = input.commandCenter;
    return {
        providerMode,
        apiBaseUrl: values.apiBaseUrl,
        applicationId: values.applicationId,
        workspaceId: values.workspaceId,
        roomId: values.groupId,
        actor: input.authSession?.username ?? input.authSession?.clientId ?? input.bootstrap.actor,
        connection: values.connection,
        authSession: input.authSession,
        timeoutMs: values.timeoutMs
    };
}

interface TicketWaitFailureInput {
    readonly commandCenter: WebSocketCommandCenterState;
    readonly label: string;
    readonly startedAtEpochMs: number;
    readonly target: string;
    readonly cause: Error;
    readonly statusText?: string;
}

function completeTicketWaitFailure(input: TicketWaitFailureInput): void {
    const message = input.cause.message;
    input.commandCenter.setLocalError(message);
    input.commandCenter.setActionFeedback(completedActionFeedback({
        label: input.label,
        startedAtEpochMs: input.startedAtEpochMs,
        target: input.target,
        ok: false,
        statusText: input.statusText ?? 'error',
        message
    }));
}
