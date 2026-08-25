import type { AuthSession } from '@shared/api/api-config.ts';
import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

import { completedActionFeedback, runningActionFeedback } from '../../../legacy/diagnostics/shared/action-feedback.ts';
import type { WebSocketCommandCenterState } from '../state/use-websocket-command-center-state.ts';
import type { WebSocketTicketActions } from '../ticket/use-websocket-ticket-wait-actions.ts';
import { resolveWebSocketUrlTemplate } from '../websocket-url-routing.ts';
import { observeRawWebSocket, type RawWebSocketEventRecord } from './observe-raw-web-socket.ts';

export interface UseRawWebSocketActionsInput {
    readonly authSession: AuthSession | undefined;
    readonly commandCenter: WebSocketCommandCenterState;
    readonly requestTicket: WebSocketTicketActions['requestTicket'];
    readonly recordEvent: (event: RawWebSocketEventRecord) => void;
}

export interface RawWebSocketActions {
    readonly open: (url?: string) => Promise<void>;
    readonly close: (reason?: string) => Promise<void>;
    readonly reconnect: () => Promise<void>;
    readonly cleanup: () => Promise<void>;
    readonly openMissingTicket: () => Promise<void>;
}

interface OpenRawWebSocketInput extends UseRawWebSocketActionsInput {
    readonly socketRef: MutableRefObject<WebSocket | undefined>;
    readonly url: string;
    readonly useTicket: boolean;
}

interface CloseRawWebSocketInput extends UseRawWebSocketActionsInput {
    readonly socketRef: MutableRefObject<WebSocket | undefined>;
    readonly reason: string;
}

interface StartRawWebSocketInput extends OpenRawWebSocketInput {
    readonly resolvedUrl: string;
    readonly label: string;
    readonly startedAtEpochMs: number;
}

interface RawWebSocketFailureInput extends OpenRawWebSocketInput {
    readonly label: string;
    readonly startedAtEpochMs: number;
    readonly cause: Error;
}

interface RecordRawWebSocketCloseInput extends CloseRawWebSocketInput {
    readonly hadSocket: boolean;
    readonly label: string;
    readonly startedAtEpochMs: number;
}

interface CloseRawWebSocketFailureInput extends CloseRawWebSocketInput {
    readonly label: string;
    readonly startedAtEpochMs: number;
    readonly cause: Error;
}

export function useRawWebSocketActions(input: UseRawWebSocketActionsInput): RawWebSocketActions {
    const socketRef = useRef<WebSocket | undefined>(undefined);
    const authKey = input.authSession
        ? `${input.authSession.clientId}:${input.authSession.sessionId}`
        : 'anonymous';
    useEffect(() => () => closeRawWebSocketOnAuthChange(socketRef), [authKey]);
    const open = (url = input.commandCenter.values.wsUrl): Promise<void> =>
        openRawWebSocket({ ...input, socketRef, url, useTicket: true });
    const close = (reason = input.commandCenter.values.closeReason): Promise<void> =>
        closeRawWebSocket({ ...input, socketRef, reason });
    const reconnect = async (): Promise<void> => {
        await close('reconnect');
        await open(input.commandCenter.values.wsUrl);
    };
    const cleanup = async (): Promise<void> => {
        input.commandCenter.setTicket(undefined);
        await close('cleanup');
    };
    const openMissingTicket = (): Promise<void> =>
        openRawWebSocket({
            ...input,
            socketRef,
            url: '{config.wsBaseUrl}/api/ws/{auth.sessionId}',
            useTicket: false
        });
    return { open, close, reconnect, cleanup, openMissingTicket };
}

async function openRawWebSocket(input: OpenRawWebSocketInput): Promise<void> {
    const label = input.useTicket ? 'Open WebSocket' : 'Open WebSocket without ticket';
    const startedAtEpochMs = Date.now();
    input.commandCenter.setBusyAction('Open WebSocket');
    input.commandCenter.setLocalError(undefined);
    input.commandCenter.setActionFeedback(runningActionFeedback(
        label,
        input.url,
        input.useTicket
            ? 'Creating a ticket and opening the raw WebSocket.'
            : 'Opening raw WebSocket without acquiring a ticket.'
    ));
    try {
        const ticket = input.useTicket ? await input.requestTicket(crypto.randomUUID()) : undefined;
        const resolvedUrl = resolveWebSocketUrlTemplate({
            template: input.url,
            apiBaseUrl: input.commandCenter.values.apiBaseUrl,
            authSession: input.authSession,
            ticket
        });
        startRawWebSocket({ ...input, resolvedUrl, label, startedAtEpochMs });
    }
    catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        completeRawWebSocketFailure({ ...input, label, startedAtEpochMs, cause });
    }
    finally {
        input.commandCenter.setBusyAction(undefined);
    }
}

function startRawWebSocket(input: StartRawWebSocketInput): void {
    input.commandCenter.setActionFeedback(
        runningActionFeedback(input.label, input.resolvedUrl, 'Opening raw WebSocket connection.')
    );
    const protocols = input.commandCenter.values.protocols.split(',').map((entry) => entry.trim()).filter(Boolean);
    input.socketRef.current?.close(input.commandCenter.values.closeCode, 'replace raw socket');
    const socket = new WebSocket(input.resolvedUrl, protocols.length > 0 ? protocols : undefined);
    input.socketRef.current = socket;
    input.commandCenter.setSequence((current) => current + 1);
    observeRawWebSocket({
        socket,
        connection: input.commandCenter.values.connection,
        url: input.resolvedUrl,
        label: input.label,
        startedAtEpochMs: input.startedAtEpochMs,
        recordEvent: input.recordEvent,
        setWaitStatus: input.commandCenter.setWaitStatus,
        setActionFeedback: input.commandCenter.setActionFeedback
    });
    input.commandCenter.setActionFeedback(completedActionFeedback({
        label: input.label,
        startedAtEpochMs: input.startedAtEpochMs,
        target: input.resolvedUrl,
        ok: true,
        status: 'requested',
        message: 'Raw WebSocket open was requested.'
    }));
}

function completeRawWebSocketFailure(input: RawWebSocketFailureInput): void {
    const message = input.cause.message;
    input.commandCenter.setLocalError(message);
    input.commandCenter.setWaitStatus('raw ws open failed');
    input.commandCenter.setActionFeedback(completedActionFeedback({
        label: input.label,
        startedAtEpochMs: input.startedAtEpochMs,
        target: input.url,
        ok: false,
        statusText: 'error',
        message
    }));
}

async function closeRawWebSocket(input: CloseRawWebSocketInput): Promise<void> {
    const label = 'Close WebSocket';
    const startedAtEpochMs = Date.now();
    input.commandCenter.setBusyAction(label);
    input.commandCenter.setLocalError(undefined);
    input.commandCenter.setActionFeedback(runningActionFeedback(
        label,
        input.commandCenter.values.wsUrl,
        'Closing the raw WebSocket if one is open.'
    ));
    try {
        const socket = input.socketRef.current;
        input.socketRef.current = undefined;
        socket?.close(input.commandCenter.values.closeCode, input.reason);
        recordRawWebSocketClose({ ...input, hadSocket: Boolean(socket), label, startedAtEpochMs });
    }
    catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        completeCloseFailure({ ...input, label, startedAtEpochMs, cause });
    }
    finally {
        input.commandCenter.setBusyAction(undefined);
    }
}

function recordRawWebSocketClose(input: RecordRawWebSocketCloseInput): void {
    input.recordEvent({
        topic: 'rallar.direct.raw_ws.close.requested',
        payload: {
            connection: input.commandCenter.values.connection,
            closeCode: input.commandCenter.values.closeCode,
            closeReason: input.reason
        },
        lastAction: input.label
    });
    input.commandCenter.setSequence((current) => current + 1);
    input.commandCenter.setActionFeedback(completedActionFeedback({
        label: input.label,
        startedAtEpochMs: input.startedAtEpochMs,
        target: input.commandCenter.values.wsUrl,
        ok: true,
        status: input.hadSocket ? 'close requested' : 'no socket',
        message: input.hadSocket ? 'Raw WebSocket close was requested.' : 'No raw WebSocket was open.'
    }));
}

function completeCloseFailure(input: CloseRawWebSocketFailureInput): void {
    const message = input.cause.message;
    input.commandCenter.setLocalError(message);
    input.commandCenter.setActionFeedback(completedActionFeedback({
        label: input.label,
        startedAtEpochMs: input.startedAtEpochMs,
        target: input.commandCenter.values.wsUrl,
        ok: false,
        statusText: 'error',
        message
    }));
}

function closeRawWebSocketOnAuthChange(socketRef: MutableRefObject<WebSocket | undefined>): void {
    const socket = socketRef.current;
    socketRef.current = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED) {
        socket.close(1000, 'rallar-black-box auth cleanup');
    }
}
