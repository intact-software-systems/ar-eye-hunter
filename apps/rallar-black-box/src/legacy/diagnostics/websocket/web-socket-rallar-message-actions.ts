import type { RallarMessage, RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarWsWaitForOpenResult } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { Either } from '@shared/resilience/Either.ts';
import {
    createDirectRallarRuntimeEvent,
    runDirectRallarWsSend,
    runDirectRallarWsSubscribe
} from '../../../direct-rallar-operations.ts';
import { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { formatDuration } from '../../shared/time-format.ts';
import { completedActionFeedback, runningActionFeedback } from '../shared/action-feedback.ts';
import type { DiagnosticControllerLifecycle } from '../shared/diagnostic-controller-lifecycle.ts';
import type { WebSocketCommandCenterActions } from './web-socket-command-center-actions.ts';
import { deriveWebSocketDiagnostics } from './websocket-diagnostics.ts';

export namespace WebSocketRallarMessageActions {
    export interface Input extends WebSocketCommandCenterActions.Input {
        readonly commandCenter: Pick<
            WebSocketCommandCenterActions,
            'runAction' | 'rejectAction' | 'recordWebSocketEvent' | 'recordDirectResult' | 'directContext'
        >;
    }
}
export class WebSocketRallarMessageActions {
    private readonly input: WebSocketRallarMessageActions.Input;
    constructor(input: WebSocketRallarMessageActions.Input) {
        this.input = input;
    }
    public readonly send = async (): Promise<void> => {
        const signal = this.input.lifetime.signal;
        if (signal.aborted) {
            return;
        }
        if (!this.input.payloadResult.ok) {
            this.input.commandCenter.rejectAction(
                'Send WebSocket JSON',
                'invalid payload',
                this.input.payloadResult.error
            );
            return;
        }
        if (this.input.values.wsScope === 'room' && !this.input.values.groupId.trim()) {
            this.input.commandCenter.rejectAction(
                'Send WebSocket JSON',
                'invalid target',
                'Room-scoped WS sends require a Group.'
            );
            return;
        }
        const payload = this.input.payloadResult.value;
        await this.input.commandCenter.runAction({
            label: 'Send WebSocket JSON',
            target: this.input.routePreview.destination,
            runningMessage: `Sending ${this.input.routePreview.selector} through Rallar WS messages.`,
            signal,
            failedWaitStatus: undefined,
            run: (startedAtEpochMs) => this.sendRoomMessage(startedAtEpochMs, payload)
        });
    };
    public readonly subscribeWs = async (): Promise<void> => {
        const signal = this.input.lifetime.signal;
        if (signal.aborted) {
            return;
        }
        if (!this.input.values.typeId.trim()) {
            this.input.commandCenter.rejectAction(
                'Subscribe WS',
                'invalid selector',
                'WS subscription requires a Type ID.'
            );
            return;
        }
        if (this.input.values.wsScope === 'room' && !this.input.values.groupId.trim()) {
            this.input.commandCenter.rejectAction(
                'Subscribe WS',
                'invalid target',
                'Room-scoped WS subscriptions require a Group.'
            );
            return;
        }
        await this.input.commandCenter.runAction({
            label: 'Subscribe WS',
            target: this.input.routePreview.destination,
            runningMessage: `Subscribing to ${this.input.routePreview.selector}.`,
            signal,
            failedWaitStatus: undefined,
            run: (startedAtEpochMs) => this.subscribeRoomMessages(startedAtEpochMs, signal)
        });
    };
    public readonly unsubscribeWs = (): void => {
        const startedAtEpochMs = this.input.nowMs();
        this.input.subscription?.unsubscribe();
        this.input.setSubscription(undefined);
        this.input.setWaitStatus('unsubscribed');
        this.input.setActionFeedback(
            completedActionFeedback({
                label: 'Unsubscribe WS',
                startedAtEpochMs,
                target: this.input.subscription?.destination ?? this.input.routePreview.destination,
                ok: true,
                status: this.input.subscription ? 'unsubscribed' : 'no subscription',
                message: this.input.subscription
                    ? 'Rallar WS subscription cleared.'
                    : 'No Rallar WS subscription was active.'
            })
        );
    };
    public readonly waitForMessage = async (): Promise<void> => {
        const signal = this.input.lifetime.signal;
        if (signal.aborted) {
            return;
        }
        const startCount = this.input.diagnostics.inboundCount;
        const startedAt = this.input.nowMs();
        const label = 'Wait for WS message';
        this.input.setWaitStatus('waiting');
        this.input.setBusyAction(label);
        this.input.setLocalError(undefined);
        this.input.setActionFeedback(
            runningActionFeedback(
                label,
                this.input.values.connection,
                `Waiting up to ${formatDuration(this.input.values.timeoutMs)} for inbound WS traffic.`
            )
        );
        try {
            const outcome = await this.waitForInboundMessage(startCount, startedAt);
            if (!signal.aborted && outcome !== 'aborted') {
                this.publishReceiveOutcome(outcome, startedAt);
            }
        }
        finally {
            if (!signal.aborted) {
                this.input.setBusyAction(undefined);
            }
        }
    };
    public readonly waitForRallarWsOpen = (): Promise<void> =>
        this.input.commandCenter.runAction({
            label: 'Wait for Rallar WS open',
            target: this.input.values.apiBaseUrl,
            runningMessage: 'Starting Rallar signaling and waiting for WS open.',
            signal: this.input.lifetime.signal,
            failedWaitStatus: 'rallar ws wait failed',
            run: (startedAtEpochMs) => this.waitForSignalingOpen(startedAtEpochMs)
        });

    private async waitForInboundMessage(
        startCount: number,
        startedAt: number
    ): Promise<DiagnosticControllerLifecycle.Observation> {
        return await this.input.lifetime.waitForObservation({
            hasObserved: () =>
                deriveWebSocketDiagnostics(this.input.stateRef.current, this.input.values.connection).inboundCount >
                    startCount,
            nowMs: this.input.nowMs,
            startedAtEpochMs: startedAt,
            timeoutMs: this.input.values.timeoutMs
        });
    }

    private async subscribeRoomMessages(startedAtEpochMs: number, signal: AbortSignal): Promise<void> {
        this.input.subscription?.unsubscribe();
        const selector = {
            typeId: this.input.values.typeId,
            ...(this.input.values.topicId ? { topicId: this.input.values.topicId } : {})
        };
        const result = await runDirectRallarWsSubscribe(
            {
                context: this.input.commandCenter.directContext(),
                selector: selector,
                handler: (message) => this.receiveRoomMessage(message),
                readFacade: loadBrowserRallarFacade,
                signal: signal,
                subscriptions: this.input.lifetime.subscriptions
            }
        );
        if (signal.aborted) {
            return;
        }
        this.input.commandCenter.recordDirectResult(result, 'Rallar WS subscribed', 'Rallar WS subscribe failed');
        const selectorLabel = `${selector.topicId ?? '*'} / ${selector.typeId}`;
        if (result.status === 'completed' && result.unsubscribe) {
            this.input.setSubscription({
                label: selectorLabel,
                destination: this.input.routePreview.destination,
                groupId: this.input.values.groupId,
                subscribedAtEpochMs: this.input.nowMs(),
                unsubscribe: result.unsubscribe
            });
            this.input.setWaitStatus('subscribed');
        }
        this.input.setActionFeedback(
            completedActionFeedback({
                label: 'Subscribe WS',
                startedAtEpochMs,
                target: this.input.routePreview.destination,
                ok: result.status === 'completed',
                status: result.status,
                durationMs: result.durationMs,
                message: result.status === 'completed'
                    ? `Subscribed to ${selectorLabel}.`
                    : (result.error?.message ?? 'Rallar WS subscribe failed.')
            })
        );
    }

    private async sendRoomMessage(startedAtEpochMs: number, payload: RallarMessagePayload): Promise<void> {
        const signal = this.input.lifetime.signal;
        const result = await runDirectRallarWsSend(
            this.input.commandCenter.directContext(),
            {
                scope: this.input.values.wsScope,
                typeId: this.input.values.typeId,
                topicId: this.input.values.topicId,
                contextId: this.input.values.contextId,
                resourceId: this.input.values.resourceId || undefined,
                payload: payload
            },
            loadBrowserRallarFacade
        );
        if (signal.aborted) {
            return;
        }
        this.input.setSequence((current) => current + 1);
        this.input.commandCenter.recordDirectResult(result, 'Rallar WS JSON sent', 'Rallar WS send failed');
        this.input.setActionFeedback(
            completedActionFeedback({
                label: 'Send WebSocket JSON',
                startedAtEpochMs,
                target: this.input.routePreview.destination,
                ok: result.status === 'completed',
                status: result.status,
                durationMs: result.durationMs,
                message: result.status === 'completed'
                    ? `Sent ${this.input.routePreview.selector}.`
                    : (result.error?.message ?? 'Rallar WS send failed.')
            })
        );
    }

    private async waitForSignalingOpen(startedAtEpochMs: number): Promise<void> {
        const signal = this.input.lifetime.signal;
        const outcome = await this.startSignalingFacade();
        if (signal.aborted) {
            return;
        }
        await outcome.fold(
            async (message) => this.publishSignalingFailure(startedAtEpochMs, message),
            async (facade) => {
                const result = await facade.ws.waitForOpen({ timeoutMs: this.input.values.timeoutMs });
                if (!signal.aborted) {
                    this.publishSignalingOutcome(startedAtEpochMs, result.status === 'open', result);
                }
            }
        );
    }

    private async startSignalingFacade(): Promise<Either<string, RallarFacade>> {
        const signal = this.input.lifetime.signal;
        if (this.input.providerMode !== 'browser-rallar') {
            return Either.ofLeft('Rallar WS wait requires provider=browser-rallar.');
        }
        if (!this.input.authSession) {
            return Either.ofLeft('Rallar WS wait requires a logged-in browser session.');
        }
        const facade = await loadBrowserRallarFacade();
        if (signal.aborted) {
            return Either.ofLeft('Rallar WS wait was abandoned.');
        }
        const { applicationId, workspaceId, groupId } = this.input.values;
        facade.configure({ apiBaseUrl: this.input.values.apiBaseUrl });
        facade.setDefaults({
            applicationId,
            workspaceId,
            room: groupId
                ? { roomId: groupId, roomRef: { applicationId, workspaceId, groupId } }
                : undefined
        });
        await facade.start({
            connect: true,
            refreshRooms: false,
            refreshPeople: false,
            timeoutMs: this.input.values.timeoutMs
        });
        return Either.ofRight(facade);
    }

    private receiveRoomMessage(message: RallarMessage<RallarMessagePayload>): void {
        this.input.commandCenter.recordWebSocketEvent(
            {
                topic: 'rallar.direct.ws.message',
                payload: {
                    roomId: message.roomId ?? this.input.values.groupId,
                    applicationId: this.input.values.applicationId,
                    workspaceId: this.input.values.workspaceId,
                    typeId: message.typeId,
                    topicId: message.topicId,
                    contextId: message.contextId,
                    resourceId: message.resourceId,
                    senderId: message.senderId,
                    data: message.payload,
                    raw: message
                },
                lastAction: 'Rallar WS message received',
                severity: 'info',
                kind: 'message'
            }
        );
    }

    private publishSignalingOutcome(
        startedAtEpochMs: number,
        open: boolean,
        result: RallarWsWaitForOpenResult
    ): void {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                kind: 'diagnostic',
                topic: open ? 'rallar.direct.ws.wait_open.completed' : 'rallar.direct.ws.wait_open.failed',
                context: this.input.commandCenter.directContext(),
                transport: 'ws',
                severity: open ? 'info' : 'error',
                payload: result
            }),
            open ? 'Rallar WS open observed' : 'Rallar WS open wait failed'
        );
        this.input.setWaitStatus(open ? 'rallar ws open' : result.status);
        this.input.setActionFeedback(
            completedActionFeedback({
                label: 'Wait for Rallar WS open',
                startedAtEpochMs,
                target: this.input.values.apiBaseUrl,
                ok: open,
                status: result.status,
                message: open ? 'Rallar signaling WebSocket is open.' : 'Rallar signaling WebSocket did not open.'
            })
        );
    }

    private publishSignalingFailure(startedAtEpochMs: number, message: string): void {
        this.input.setWaitStatus('rallar ws wait failed');
        this.input.setLocalError(message);
        this.input.setActionFeedback(
            completedActionFeedback({
                label: 'Wait for Rallar WS open',
                startedAtEpochMs,
                target: this.input.values.apiBaseUrl,
                ok: false,
                statusText: 'error',
                message
            })
        );
    }

    private publishReceiveOutcome(
        outcome: Exclude<DiagnosticControllerLifecycle.Observation, 'aborted'>,
        startedAt: number
    ): void {
        const observed = outcome !== 'timeout';
        const message = observed ? 'A WebSocket message was observed.' : 'Timed out waiting for WebSocket message.';
        this.input.setWaitStatus(observed ? 'message observed' : 'timeout');
        if (!observed) {
            this.input.setLocalError(message);
        }
        this.input.setActionFeedback(
            completedActionFeedback({
                label: 'Wait for WS message',
                startedAtEpochMs: startedAt,
                target: this.input.values.connection,
                ok: observed,
                ...(observed ? { status: 'observed' } : { statusText: 'timeout' }),
                message
            })
        );
    }
}
