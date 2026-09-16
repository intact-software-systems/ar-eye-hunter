import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { RallarMessage } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarRealtimeMessage } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type * as React from 'react';
import { parseJsonText, splitCsvValues } from '../../shared/json-presentation.ts';
import { recordValue } from '../../shared/record-value.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import {
    completedActionFeedback,
    runningActionFeedback,
    type CommandCenterActionFeedback
} from '../shared/action-feedback.ts';
import type {
    RtcRealtimeActivity,
    RtcRealtimeFormValues,
    RtcRealtimeOperations,
    RtcRealtimeReceivedRow,
    RtcRealtimeSubscriptionRow
} from './rtc-realtime-contracts.ts';
import type { RtcRealtimeFacadeSession } from './rtc-realtime-facade-session.ts';
import { toRtcRealtimeRecipe } from './to-rtc-realtime-recipe.ts';
import { toRtcRealtimeSendInputs, type RtcRealtimeSendInputs } from './to-rtc-realtime-send-inputs.ts';

export namespace RtcRealtimeActions {
    export interface Input {
        readonly state: RallarBlackBoxTestState;
        readonly authSession: AuthSession | undefined;
        readonly globalValues: CommandCenterGlobalValues;
        readonly form: RtcRealtimeFormValues;
        readonly session: RtcRealtimeFacadeSession;
        readonly subscriptionsRef: React.RefObject<readonly RtcRealtimeSubscriptionRow[]>;
        readonly setSubscriptions: React.Dispatch<React.SetStateAction<readonly RtcRealtimeSubscriptionRow[]>>;
        readonly setReceived: React.Dispatch<React.SetStateAction<readonly RtcRealtimeReceivedRow[]>>;
        readonly setBusyAction: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly setActionFeedback: React.Dispatch<React.SetStateAction<CommandCenterActionFeedback>>;
        readonly setResult: React.Dispatch<React.SetStateAction<RtcRealtimeActivity['result']>>;
        readonly setHealth: React.Dispatch<React.SetStateAction<RtcRealtimeActivity['health']>>;
    }

    export interface Attempt {
        readonly label: string;
        readonly target: string;
        readonly topic: string;
        readonly startedAtEpochMs: number;
    }
}

const RECEIVED_ROW_LIMIT = 50;

export class RtcRealtimeActions implements RtcRealtimeOperations {
    private readonly input: RtcRealtimeActions.Input;
    private readonly activeGroupId: string;

    constructor(input: RtcRealtimeActions.Input) {
        this.input = input;
        this.activeGroupId = input.globalValues.roomId.trim();
    }

    readonly subscribeRealtime = (): Promise<void> =>
        this.runAction(
            'Subscribe realtime',
            () =>
                this.input.session.runJoined('subscribe-realtime', async (facade) => {
                    const { laneId } = this.input.form;
                    const groupId = this.activeGroupId || '-';
                    const unsubscribe = facade.realtime.onJson(
                        laneId,
                        (message) => this.addReceived(toRealtimeRow({ message, groupId, rowId: createReceivedRowId() }))
                    );
                    this.addSubscription({
                        subscriptionId: `realtime:${groupId}:${laneId || '-'}`,
                        transport: 'realtime',
                        label: `lane ${laneId || '-'}`,
                        laneId,
                        groupId,
                        subscribedAtEpochMs: Date.now(),
                        unsubscribe
                    });
                    return { subscribed: 'realtime', laneId };
                })
        );

    readonly subscribeRtcMessages = (): Promise<void> =>
        this.runAction(
            'Subscribe RTC messages',
            () =>
                this.input.session.runJoined('subscribe-rtc-messages', async (facade) => {
                    const { form } = this.input;
                    const selector = { typeId: form.typeId, ...(form.topicId ? { topicId: form.topicId } : {}) };
                    const unsubscribe = facade.messages.rtc.onMessage(selector, (message) =>
                        this.addReceived(toRtcMessageRow({
                            message,
                            form,
                            activeGroupId: this.activeGroupId,
                            rowId: createReceivedRowId(),
                            atEpochMs: Date.now()
                        })));
                    this.addSubscription({
                        subscriptionId: `messages.rtc:${this.activeGroupId || '-'}:${
                            form.topicId || '*'
                        }:${form.typeId}`,
                        transport: 'messages.rtc',
                        label: `${form.topicId || '*'} / ${form.typeId}`,
                        laneId: form.laneId,
                        groupId: this.activeGroupId || '-',
                        subscribedAtEpochMs: Date.now(),
                        unsubscribe
                    });
                    return { subscribed: 'messages.rtc', selector };
                })
        );

    readonly clearSubscriptions = (): void => {
        const startedAtEpochMs = Date.now();
        const { subscriptionsRef, session } = this.input;
        subscriptionsRef.current.forEach((subscription) => subscription.unsubscribe());
        subscriptionsRef.current = [];
        this.input.setSubscriptions([]);
        this.input.setActionFeedback(completedActionFeedback({
            label: 'Clear RTC/Realtimes subscriptions',
            startedAtEpochMs,
            target: this.activeGroupId || '-',
            ok: true,
            status: 'cleared',
            message: 'RTC/Realtimes subscriptions cleared.'
        }));
        session.recordEvent({
            topic: 'rallar.direct.rtc_realtime.unsubscribe.completed',
            severity: 'info',
            payload: {},
            lastAction: 'RTC/Realtimes subscriptions cleared'
        });
    };

    readonly sendRealtime = (): Promise<void> =>
        this.runAction('Send realtime JSON', () => {
            const { realtime } = this.toSendInputs(parseJsonText(this.input.form.payloadText, {}));
            return this.input.session.runJoined('send-realtime-json', (facade) => facade.realtime.sendJson(realtime));
        });

    readonly sendRtcMessage = (): Promise<void> =>
        this.runAction('Send RTC message', () => {
            const { messagesRtc } = this.toSendInputs(parseJsonText(this.input.form.payloadText, {}));
            return this.input.session.runJoined('send-rtc-message', (facade) => facade.messages.rtc.send(messagesRtc));
        });

    readonly waitForRoomLane = (): Promise<void> =>
        this.runAction('Wait room lane', () =>
            this.input.session.runJoined('wait-room-lane', (facade) => {
                const { globalValues: { applicationId, workspaceId }, form: { laneId, timeoutMs } } = this.input;
                const room = { applicationId, workspaceId, groupId: this.activeGroupId };
                return facade.rtc.waitForRoomLane(room, laneId, { timeoutMs });
            }));

    readonly refreshHealth = (): Promise<void> =>
        this.runAction(
            'Refresh lane health',
            () =>
                this.input.session.runJoined('refresh-lane-health', async (facade) => {
                    const peerIds = splitCsvValues(this.input.form.peerIdsText);
                    const laneId = this.input.form.laneId;
                    const nextHealth = facade.realtime.health({
                        peerIds: peerIds.length > 0 ? peerIds : undefined,
                        laneIds: laneId ? [laneId] : undefined
                    });
                    this.input.setHealth(nextHealth);
                    return nextHealth;
                })
        );

    readonly copyRecipe = (): void => {
        const { form, globalValues, state, authSession } = this.input;
        const sendInputs = this.toSendInputs(toRecipePayload(form.payloadText));
        void navigator.clipboard?.writeText(
            redactedJson(toRtcRealtimeRecipe({ form, globalValues, sendInputs }), state, authSession)
        );
    };

    private async runAction(label: string, action: () => Promise<RtcRealtimeActivity['result']>): Promise<void> {
        const { transport } = this.input.form;
        this.input.setBusyAction(label);
        this.input.setLocalError(undefined);
        const attempt: RtcRealtimeActions.Attempt = {
            label,
            target: `${this.activeGroupId || '-'} / ${transport}`,
            topic: `rallar.direct.${transport}.${label.toLowerCase().replaceAll(' ', '_')}`,
            startedAtEpochMs: Date.now()
        };
        this.input.setActionFeedback(
            runningActionFeedback(label, attempt.target, 'Calling the browser Rallar facade.')
        );
        try {
            const result = await action();
            this.input.setResult(result);
            this.recordCompleted(attempt, result);
        }
        catch (error) {
            this.recordFailed(attempt, error instanceof Error ? error.message : String(error));
        }
        finally {
            this.input.setBusyAction(undefined);
        }
    }

    private recordCompleted(attempt: RtcRealtimeActions.Attempt, result: RtcRealtimeActivity['result']): void {
        const { label, startedAtEpochMs, target } = attempt;
        this.input.setActionFeedback(
            completedActionFeedback({
                label,
                startedAtEpochMs,
                target,
                ok: true,
                status: 'completed',
                message: `${label} completed.`
            })
        );
        this.input.session.recordEvent({
            topic: `${attempt.topic}.completed`,
            severity: 'info',
            payload: result,
            lastAction: `${label} completed`
        });
    }

    private recordFailed(attempt: RtcRealtimeActions.Attempt, message: string): void {
        const { label, startedAtEpochMs, target } = attempt;
        this.input.setLocalError(message);
        this.input.setActionFeedback(
            completedActionFeedback({ label, startedAtEpochMs, target, ok: false, statusText: 'error', message })
        );
        this.input.session.recordEvent({
            topic: `${attempt.topic}.failed`,
            severity: 'error',
            payload: { error: message },
            lastAction: `${label} failed`
        });
    }

    private addSubscription(subscription: RtcRealtimeSubscriptionRow): void {
        const { subscriptionsRef } = this.input;
        const replaced = subscriptionsRef.current.filter((entry) =>
            entry.subscriptionId === subscription.subscriptionId
        );
        replaced.forEach((entry) => entry.unsubscribe());
        subscriptionsRef.current = [
            ...subscriptionsRef.current.filter((entry) => entry.subscriptionId !== subscription.subscriptionId),
            subscription
        ];
        this.input.setSubscriptions(subscriptionsRef.current);
    }

    private addReceived(row: RtcRealtimeReceivedRow): void {
        this.input.setReceived((current) => [...current, row].slice(-RECEIVED_ROW_LIMIT));
        this.input.session.recordEvent({
            topic: 'rallar.direct.rtc_realtime.message',
            severity: 'info',
            payload: row,
            lastAction: 'RTC/Realtimes message received'
        });
    }

    private toSendInputs(payload: RtcRealtimeSendInputs.Source['payload']): RtcRealtimeSendInputs {
        return toRtcRealtimeSendInputs({ form: this.input.form, globalValues: this.input.globalValues, payload });
    }
}

interface RealtimeRowSource {
    readonly message: RallarRealtimeMessage<RtcRealtimeReceivedRow['payload']>;
    readonly groupId: string;
    readonly rowId: string;
}

interface RtcMessageRowSource {
    readonly message: RallarMessage<never>;
    readonly form: RtcRealtimeFormValues;
    readonly activeGroupId: string;
    readonly rowId: string;
    readonly atEpochMs: number;
}

function toRealtimeRow({ message, groupId, rowId }: RealtimeRowSource): RtcRealtimeReceivedRow {
    return {
        rowId,
        atEpochMs: message.receivedAtEpochMs,
        transport: 'realtime',
        peerId: message.peerId,
        laneId: message.laneId,
        roomId: groupId,
        typeId: '-',
        topicId: '-',
        contextId: groupId,
        payload: message.data,
        raw: message
    };
}

/** RTC message fields are read loosely because the diagnostic shows whatever the sender put on the wire. */
function toRtcMessageRow(
    { message, form, activeGroupId, rowId, atEpochMs }: RtcMessageRowSource
): RtcRealtimeReceivedRow {
    const record = recordValue(message);
    return {
        rowId,
        atEpochMs,
        transport: 'messages.rtc',
        peerId: String(record.senderId ?? record.peerId ?? '-'),
        laneId: form.laneId,
        roomId: String(record.roomId ?? activeGroupId),
        typeId: String(record.typeId ?? form.typeId),
        topicId: String(record.topicId ?? form.topicId),
        contextId: String(record.contextId ?? form.contextId),
        payload: record.payload ?? message,
        raw: message
    };
}

function toRecipePayload(payloadText: string): RtcRealtimeSendInputs.Source['payload'] {
    try {
        return parseJsonText(payloadText, {});
    }
    catch {
        return {};
    }
}

function createReceivedRowId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
