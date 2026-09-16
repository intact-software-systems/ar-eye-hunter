import type { Either } from '@shared/resilience/Either.ts';
import { formatTime } from '../../shared/time-format.ts';
import { completedActionFeedback, runningActionFeedback } from '../shared/action-feedback.ts';
import type { AuthCommandCenterTicket } from '../shared/auth-command-center-ticket.ts';
import { observeRawWebSocket } from './observe-raw-web-socket.ts';
import { requestWebSocketTicket } from './request-web-socket-ticket.ts';
import type { WebSocketCommandCenterActions } from './web-socket-command-center-actions.ts';
import { resolveWebSocketUrlTemplate } from './websocket-routing.ts';

export namespace WebSocketRawSocketActions {
    export interface Input extends WebSocketCommandCenterActions.Input {
        readonly commandCenter: Pick<
            WebSocketCommandCenterActions,
            'runAction' | 'failAction' | 'recordWebSocketEvent'
        >;
    }
    export interface OpenRequest {
        readonly url: string;
        readonly useTicket: boolean;
    }
    export interface OpenAttempt {
        readonly ticketRequestId: string | undefined;
        readonly url: string;
        readonly label: string;
        readonly startedAtEpochMs: number;
        readonly signal: AbortSignal;
    }
}
export class WebSocketRawSocketActions {
    private readonly input: WebSocketRawSocketActions.Input;
    constructor(input: WebSocketRawSocketActions.Input) {
        this.input = input;
    }
    public readonly open = (url: string): Promise<void> => this.startOpen({ url, useTicket: true });
    public readonly openMissingTicket = (): Promise<void> =>
        this.startOpen({ url: '{config.wsBaseUrl}/api/ws/{auth.sessionId}', useTicket: false });
    public readonly close = (reason: string): Promise<void> =>
        this.input.commandCenter.runAction({
            label: 'Close WebSocket',
            target: this.input.values.wsUrl,
            runningMessage: 'Closing the raw WebSocket if one is open.',
            signal: undefined,
            failedWaitStatus: undefined,
            run: (startedAtEpochMs) => this.closeRawSocket(reason, startedAtEpochMs)
        });
    public readonly reconnect = async (): Promise<void> => {
        await this.close('reconnect');
        await this.open(this.input.values.wsUrl);
    };
    public readonly cleanup = async (): Promise<void> => {
        this.input.setTicket(undefined);
        const closing = this.close('cleanup');
        this.input.rawSocketLifetime.close();
        this.input.rawSocketLifetime.activate();
        await closing;
    };
    public readonly createTicket = (): Promise<void> => {
        const signal = this.input.rawSocketLifetime.signal;
        if (signal.aborted) {
            return Promise.resolve();
        }
        const requestId = this.input.createRequestId();
        const label = 'Create WS ticket';
        const target = '/api/auth/ws-ticket';
        return this.input.commandCenter.runAction({
            label,
            target,
            runningMessage: 'Requesting a WebSocket ticket.',
            signal,
            failedWaitStatus: undefined,
            run: async (startedAtEpochMs) => {
                const requested = await this.requestWsTicket(requestId, signal);
                if (!signal.aborted) {
                    requested.fold(
                        (message) =>
                            this.input.commandCenter.failAction({
                                label,
                                target,
                                failedWaitStatus: undefined,
                                startedAtEpochMs,
                                message
                            }),
                        (nextTicket) => this.publishCreatedTicket(nextTicket, startedAtEpochMs)
                    );
                }
            }
        });
    };

    private startOpen({ url, useTicket }: WebSocketRawSocketActions.OpenRequest): Promise<void> {
        const signal = this.input.rawSocketLifetime.signal;
        if (signal.aborted) {
            return Promise.resolve();
        }
        const ticketRequestId = useTicket ? this.input.createRequestId() : undefined;
        const label = useTicket ? 'Open WebSocket' : 'Open WebSocket without ticket';
        return this.input.commandCenter.runAction({
            label,
            target: url,
            runningMessage: useTicket
                ? 'Creating a ticket and opening the raw WebSocket.'
                : 'Opening raw WebSocket without acquiring a ticket.',
            signal,
            failedWaitStatus: 'raw ws open failed',
            run: (startedAtEpochMs) => this.openRawSocket({ ticketRequestId, url, label, startedAtEpochMs, signal })
        });
    }

    private async requestWsTicket(
        requestId: string,
        signal: AbortSignal
    ): Promise<Either<string, AuthCommandCenterTicket>> {
        const requested = await requestWebSocketTicket({
            apiBaseUrl: this.input.values.apiBaseUrl,
            authSession: this.input.authSession,
            requestId,
            timeoutMs: this.input.values.timeoutMs,
            nowMs: this.input.nowMs
        });
        if (!signal.aborted) {
            requested.foldRight(this.input.setTicket);
        }
        return requested;
    }

    private async openRawSocket(attempt: WebSocketRawSocketActions.OpenAttempt): Promise<void> {
        const { ticketRequestId, url, label, startedAtEpochMs, signal } = attempt;
        if (ticketRequestId === undefined) {
            this.openResolvedRawSocket(attempt, undefined);
            return;
        }
        const requested = await this.requestWsTicket(ticketRequestId, signal);
        if (signal.aborted) {
            return;
        }
        requested.fold(
            (message) =>
                this.input.commandCenter.failAction({
                    label,
                    target: url,
                    failedWaitStatus: 'raw ws open failed',
                    startedAtEpochMs,
                    message
                }),
            (nextTicket) => this.openResolvedRawSocket(attempt, nextTicket)
        );
    }

    private openResolvedRawSocket(
        attempt: WebSocketRawSocketActions.OpenAttempt,
        nextTicket: AuthCommandCenterTicket | undefined
    ): void {
        const { url, label } = attempt;
        const resolvedUrl = resolveWebSocketUrlTemplate(
            url,
            this.input.values.apiBaseUrl,
            this.input.authSession,
            nextTicket
        );
        this.input.setActionFeedback(runningActionFeedback(label, resolvedUrl, 'Opening raw WebSocket connection.'));
        this.installRawSocket(attempt, resolvedUrl);
    }

    private installRawSocket(attempt: WebSocketRawSocketActions.OpenAttempt, resolvedUrl: string): void {
        const { label, startedAtEpochMs, signal } = attempt;
        const protocols = this.input.values.protocols
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
        this.input.rawSocketRef.current?.close(this.input.values.closeCode, 'replace raw socket');
        const socket = new WebSocket(
            resolvedUrl,
            protocols.length > 0 ? protocols : undefined
        );
        this.input.rawSocketRef.current = socket;
        this.input.rawSocketLifetime.subscriptions.add(() => {
            if (this.input.rawSocketRef.current === socket) {
                this.input.rawSocketRef.current = undefined;
            }
            if (socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED) {
                socket.close(1000, 'rallar-black-box auth cleanup');
            }
        });
        this.input.setSequence((current) => current + 1);
        observeRawWebSocket({
            socket,
            connection: this.input.values.connection,
            url: resolvedUrl,
            label,
            startedAtEpochMs,
            recordEvent: this.input.commandCenter.recordWebSocketEvent,
            setWaitStatus: this.input.setWaitStatus,
            setActionFeedback: this.input.setActionFeedback,
            signal
        });
        this.input.setActionFeedback(
            completedActionFeedback({
                label,
                startedAtEpochMs,
                target: resolvedUrl,
                ok: true,
                status: 'requested',
                message: 'Raw WebSocket open was requested.'
            })
        );
    }

    private closeRawSocket(reason: string, startedAtEpochMs: number): void {
        const socket = this.input.rawSocketRef.current;
        this.input.rawSocketRef.current = undefined;
        socket?.close(this.input.values.closeCode, reason);
        this.input.commandCenter.recordWebSocketEvent(
            {
                topic: 'rallar.direct.raw_ws.close.requested',
                payload: {
                    connection: this.input.values.connection,
                    closeCode: this.input.values.closeCode,
                    closeReason: reason
                },
                lastAction: 'Close WebSocket'
            }
        );
        this.input.setSequence((current) => current + 1);
        this.input.setActionFeedback(
            completedActionFeedback({
                label: 'Close WebSocket',
                startedAtEpochMs,
                target: this.input.values.wsUrl,
                ok: true,
                status: socket ? 'close requested' : 'no socket',
                message: socket
                    ? 'Raw WebSocket close was requested.'
                    : 'No raw WebSocket was open.'
            })
        );
    }

    private publishCreatedTicket(nextTicket: AuthCommandCenterTicket, startedAtEpochMs: number): void {
        this.input.commandCenter.recordWebSocketEvent(
            {
                topic: 'rallar.direct.raw_ws.ticket.created',
                payload: {
                    sessionId: nextTicket.sessionId,
                    expiresAtEpochMs: nextTicket.expiresAtEpochMs,
                    ticket: '<redacted:ws-ticket>'
                },
                lastAction: 'Create WS ticket'
            }
        );
        this.input.setActionFeedback(
            completedActionFeedback({
                label: 'Create WS ticket',
                startedAtEpochMs,
                target: '/api/auth/ws-ticket',
                ok: true,
                status: 'created',
                message: `Ticket expires at ${formatTime(nextTicket.expiresAtEpochMs)}.`
            })
        );
    }
}
