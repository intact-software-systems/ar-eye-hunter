import type {
    RallarDirectorOutputOptions,
    RallarDirectorRelayEnvelope,
    RallarDirectorRelaySendResult,
    RallarDirectorStatus
} from '@shared-web/browser/director/rallar-director-facade.ts';
import { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import { AL_CHANNEL_SEND_DEFAULTS } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import type { ALDeliveryFailure } from '@shared/alm/delivery/al-delivery-failure.ts';
import {
    AL_DELIVERY_ADMITTED_STATES,
    isALDeliveryAdmitted,
    type ALDeliveryLifecycle
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

export const RALLAR_DIRECTOR_RELAY_PROTOCOL = 'rallar.director.relay.v1';

const DIRECTOR_COMMAND_UNCONFIRMED_REASON = 'The director did not confirm the command before its deadline.';

export namespace BrowserDirectorRelayTransport {
    export interface Input {
        readonly messages: RallarMessagesOperations;
        readSession(): AuthSession | undefined;
    }

    export interface SendCommandInput<T> {
        readonly current: RallarDirectorStatus;
        readonly topicId: string;
        readonly typeId: string;
        readonly payload: T;
    }

    export interface SendRoomEnvelopeInput<T> {
        readonly current: RallarDirectorStatus;
        readonly topicId: string;
        readonly typeId: string;
        readonly payload: T;
        /** Undefined sends best effort; a stated ack asks the frozen room audience for a logical receipt. */
        readonly ack: RallarDirectorOutputOptions['ack'] | undefined;
    }
}

export class BrowserDirectorRelayTransport {
    private readonly input: BrowserDirectorRelayTransport.Input;

    public constructor(input: BrowserDirectorRelayTransport.Input) {
        this.input = input;
    }

    public async sendCommand<T>(
        input: BrowserDirectorRelayTransport.SendCommandInput<T>
    ): Promise<RallarDirectorRelaySendResult> {
        const rejection = this.readCommandRejection(input.current);
        if (rejection) {
            return rejection;
        }
        const roomRef = input.current.roomRef;
        if (!roomRef) {
            throw new Error('Validated director command target is missing.');
        }
        try {
            const receipt = await this.input.messages
                .room<RallarDirectorRelayEnvelope<T>>({
                    topicId: input.topicId,
                    typeId: input.typeId,
                    roomRef,
                    purpose: 'command'
                })
                .send(createEnvelope(input), {
                    ack: 'group-leader',
                    strategy: 'rtc-with-ws-fallback'
                });
            return await readDirectorReceipt(receipt);
        }
        catch (error) {
            if (!isRallarValidationError(error)) {
                throw error;
            }
            return { status: 'failed', reason: error.message };
        }
    }

    public async sendRoomEnvelope<T>(
        input: BrowserDirectorRelayTransport.SendRoomEnvelopeInput<T>
    ): Promise<RallarDirectorRelaySendResult> {
        const rejection = this.readRoomSendRejection(input.current);
        if (rejection) {
            return rejection;
        }
        const roomRef = input.current.roomRef;
        if (!roomRef) {
            throw new Error('Validated director room target is missing.');
        }
        return input.ack === undefined
            ? await this.sendBestEffortRoomEnvelope(input, roomRef)
            : await this.sendReceiptRoomEnvelope(input, roomRef);
    }

    private async sendBestEffortRoomEnvelope<T>(
        input: BrowserDirectorRelayTransport.SendRoomEnvelopeInput<T>,
        roomRef: GroupRef
    ): Promise<RallarDirectorRelaySendResult> {
        const message = {
            roomRef,
            topicId: input.topicId,
            typeId: input.typeId,
            payload: createEnvelope(input),
            reliability: 'best-effort' as const,
            ack: 'none' as const,
            ttlMs: 5_000
        };
        const rtc = await this.input.messages.rtc.send(message);
        const rtcOutcome = await rtc.wait({ until: AL_DELIVERY_ADMITTED_STATES, timeoutMs: message.ttlMs });
        if (isSuccessfulDirectorDelivery(rtcOutcome.lifecycle)) {
            return { status: 'sent', rtc };
        }
        const ws = await this.input.messages.ws.send(message);
        const wsOutcome = await ws.wait({ until: AL_DELIVERY_ADMITTED_STATES, timeoutMs: message.ttlMs });
        return isSuccessfulDirectorDelivery(wsOutcome.lifecycle)
            ? { status: 'sent', rtc, ws }
            : {
                status: 'failed',
                rtc,
                ws,
                reason: wsOutcome.lifecycle.evidence.reason ?? rtcOutcome.lifecycle.evidence.reason
            };
    }

    private async sendReceiptRoomEnvelope<T>(
        input: BrowserDirectorRelayTransport.SendRoomEnvelopeInput<T>,
        roomRef: GroupRef
    ): Promise<RallarDirectorRelaySendResult> {
        const ttlMs = BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS;
        const receipt = await this.input.messages
            .room<RallarDirectorRelayEnvelope<T>>({
                topicId: input.topicId,
                typeId: input.typeId,
                roomRef,
                purpose: 'notification'
            })
            .send(createEnvelope(input), {
                strategy: 'rtc-with-ws-fallback',
                reliability: 'at-least-once',
                ack: input.ack,
                ttlMs
            });
        const outcome = await receipt.wait({ until: AL_DELIVERY_ADMITTED_STATES, timeoutMs: ttlMs });
        return isSuccessfulDirectorDelivery(outcome.lifecycle)
            ? { status: 'sent', receipt }
            : { status: 'failed', receipt, reason: outcome.lifecycle.evidence.reason };
    }

    private readCommandRejection(
        current: RallarDirectorStatus
    ): RallarDirectorRelaySendResult | undefined {
        if (!this.input.readSession()) {
            return { status: 'no-director', reason: 'Auth session ended.' };
        }
        if (!current.appointment || !current.roomRef || !current.roomId) {
            return {
                status: 'no-director',
                reason: 'No director is appointed for this room.'
            };
        }
        if (!current.isFresh) {
            return {
                status: 'stale-director',
                reason: 'The appointed director is stale or inactive.'
            };
        }
        return current.isDirector
            ? { status: 'not-director', reason: 'The local session is the director.' }
            : undefined;
    }

    private readRoomSendRejection(
        current: RallarDirectorStatus
    ): RallarDirectorRelaySendResult | undefined {
        if (!this.input.readSession()) {
            return { status: 'no-director', reason: 'Auth session ended.' };
        }
        if (!current.appointment || !current.roomRef || !current.roomId) {
            return {
                status: 'no-director',
                reason: 'No director is appointed for this room.'
            };
        }
        return current.isDirector
            ? undefined
            : {
                status: 'not-director',
                reason: 'Only the appointed local director can send director output.'
            };
    }
}

/** The room's leader confirms a command; a room without one refuses it `no-leader` on either carrier (D167). */
async function readDirectorReceipt(receipt: RallarMessageHandle): Promise<RallarDirectorRelaySendResult> {
    const outcome = await receipt.wait({
        until: ['acknowledged'],
        timeoutMs: AL_CHANNEL_SEND_DEFAULTS.command.ttlMs
    });
    const lifecycle = outcome.lifecycle;
    if (lifecycle.state === 'acknowledged') {
        return { status: 'sent', receipt };
    }
    return {
        status: isNoLeaderFailure(lifecycle.evidence.failure) ? 'no-director' : 'failed',
        receipt,
        reason: lifecycle.evidence.reason ?? DIRECTOR_COMMAND_UNCONFIRMED_REASON
    };
}

function isNoLeaderFailure(failure: ALDeliveryFailure | undefined): boolean {
    switch (failure?.kind) {
        case 'refused':
            return failure.reason === 'no-leader';
        case 'relay-rejected':
            return failure.rejection.reason === 'no-leader';
        default:
            return false;
    }
}

function createEnvelope<T>(
    input: BrowserDirectorRelayTransport.SendCommandInput<T> | BrowserDirectorRelayTransport.SendRoomEnvelopeInput<T>
): RallarDirectorRelayEnvelope<T> {
    if (!input.current.appointment || !input.current.roomId) {
        throw new Error('Cannot create director envelope without appointment.');
    }
    return {
        protocol: RALLAR_DIRECTOR_RELAY_PROTOCOL,
        topicId: input.topicId,
        typeId: input.typeId,
        roomId: input.current.roomId,
        epoch: input.current.appointment.epoch,
        sentAtEpochMs: Date.now(),
        payload: input.payload
    };
}

function isSuccessfulDirectorDelivery(lifecycle: ALDeliveryLifecycle): boolean {
    // A newer intent replaced it; falling back over WS would resend stale state.
    return isALDeliveryAdmitted(lifecycle) || lifecycle.state === 'superseded';
}
