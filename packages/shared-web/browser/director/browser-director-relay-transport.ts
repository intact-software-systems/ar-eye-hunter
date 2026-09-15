import type {
    RallarDirectorRelayEnvelope,
    RallarDirectorRelaySendResult,
    RallarDirectorStatus
} from '@shared-web/browser/director/rallar-director-facade.ts';
import { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type {
    RallarTargetedChannel,
    RallarTargetedChannelDefinition
} from '@shared-web/browser/rallar-realtime-facade.ts';
import {
    AL_DELIVERY_ADMITTED_STATES,
    isALDeliveryAdmitted,
    type ALDeliveryLifecycle
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

export const RALLAR_DIRECTOR_RELAY_PROTOCOL = 'rallar.director.relay.v1';

export namespace BrowserDirectorRelayTransport {
    export interface Input {
        readonly messages: RallarMessagesOperations;
        readSession(): AuthSession | undefined;
        createTargetedChannel<T>(
            definition: RallarTargetedChannelDefinition
        ): RallarTargetedChannel<T>;
        sendWsUnicast<T>(
            input: BrowserRallarMessageSender.WsUnicastInput<T>
        ): Promise<RallarMessageHandle>;
    }

    export interface SendIntentInput<T> {
        readonly current: RallarDirectorStatus;
        readonly laneId: string;
        readonly topicId: string;
        readonly typeId: string;
        readonly payload: T;
    }

    export interface SendRoomEnvelopeInput<T> {
        readonly current: RallarDirectorStatus;
        readonly topicId: string;
        readonly typeId: string;
        readonly payload: T;
    }
}

export class BrowserDirectorRelayTransport {
    private readonly input: BrowserDirectorRelayTransport.Input;

    public constructor(input: BrowserDirectorRelayTransport.Input) {
        this.input = input;
    }

    public async sendIntent<T>(
        input: BrowserDirectorRelayTransport.SendIntentInput<T>
    ): Promise<RallarDirectorRelaySendResult> {
        const rejection = this.readIntentRejection(input.current);
        if (rejection) {
            return rejection;
        }
        const appointment = input.current.appointment;
        if (!appointment || !input.current.roomId) {
            throw new Error('Validated director intent target is missing.');
        }
        const envelope = createEnvelope(input);
        const rtc = await this.input
            .createTargetedChannel<RallarDirectorRelayEnvelope<T>>({
                peerId: appointment.sessionId,
                laneId: input.laneId
            })
            .send(envelope);
        if (rtc.status === 'sent') {
            return { status: 'sent', rtc };
        }
        return await this.sendIntentWithWsFallback(input, envelope, rtc);
    }

    public async sendRoomEnvelope<T>(
        input: BrowserDirectorRelayTransport.SendRoomEnvelopeInput<T>
    ): Promise<RallarDirectorRelaySendResult> {
        const rejection = this.readRoomSendRejection(input.current);
        if (rejection) {
            return rejection;
        }
        if (!input.current.roomRef) {
            throw new Error('Validated director room target is missing.');
        }
        const envelope = createEnvelope(input);
        const message = {
            roomRef: input.current.roomRef,
            topicId: input.topicId,
            typeId: input.typeId,
            payload: envelope,
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

    private async sendIntentWithWsFallback<T>(
        input: BrowserDirectorRelayTransport.SendIntentInput<T>,
        envelope: RallarDirectorRelayEnvelope<T>,
        rtc: RallarDirectorRelaySendResult['rtc']
    ): Promise<RallarDirectorRelaySendResult> {
        const appointment = input.current.appointment;
        if (!appointment || !input.current.roomId) {
            throw new Error('Validated director intent target is missing.');
        }
        const ws = await this.input.sendWsUnicast({
            peerId: appointment.sessionId,
            payload: envelope,
            typeId: input.typeId,
            route: { topicId: input.topicId, contextId: input.current.roomId }
        });
        const wsOutcome = await ws.wait({
            until: AL_DELIVERY_ADMITTED_STATES,
            timeoutMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS
        });
        return isSuccessfulDirectorDelivery(wsOutcome.lifecycle)
            ? { status: 'sent', rtc, ws }
            : { status: 'failed', rtc, ws, reason: wsOutcome.lifecycle.evidence.reason };
    }

    private readIntentRejection(
        current: RallarDirectorStatus
    ): RallarDirectorRelaySendResult | undefined {
        if (!this.input.readSession()) {
            return { status: 'no-director', reason: 'Auth session ended.' };
        }
        if (!current.appointment || !current.roomId) {
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

function createEnvelope<T>(
    input: BrowserDirectorRelayTransport.SendRoomEnvelopeInput<T>
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
