import type {
    RallarDirectorOutputOptions,
    RallarDirectorRelayClaim,
    RallarDirectorRelayEnvelope,
    RallarDirectorRelaySendResult,
    RallarDirectorRelaySendStatus,
    RallarDirectorStatus
} from '@shared-web/browser/director/rallar-director-facade.ts';
import { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import type {
    RallarMessageHandle,
    RallarTypedMessageChannel
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
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

type DirectorCarrier = 'ws' | 'rtc';

export const RALLAR_DIRECTOR_RELAY_PROTOCOL = 'rallar.director.relay.v1';

const DIRECTOR_COMMAND_UNCONFIRMED_REASON = 'The director did not confirm the command before its deadline.';

/** How long a send nothing retries lives: an unreceipted output, a heartbeat or a snapshot. */
const DIRECTOR_BEST_EFFORT_TTL_MS = 5_000;

export namespace BrowserDirectorRelayTransport {
    export interface Input {
        readonly messages: RallarMessagesOperations;
        readSession(): AuthSession | undefined;
        /**
         * True while a held connection's WebSocket is not open: a WS send is then admitted to its queue and reaches no
         * member until the socket reopens. Without a connection the send's own connect opens one.
         */
        isWebSocketDown(): boolean;
    }

    /** What every director send stamps its envelope from: a command, an output, a heartbeat or a snapshot. */
    export interface EnvelopeInput<T> {
        readonly current: RallarDirectorStatus;
        readonly topicId: string;
        readonly typeId: string;
        readonly payload: T;
    }

    export interface SendCommandInput<T> extends EnvelopeInput<T> {
        /** The resource an intent claims; undefined for a shared intent and every sync request. */
        readonly claim: RallarDirectorRelayClaim | undefined;
    }

    /** A heartbeat or a snapshot: best effort over one carrier, then the other. */
    export interface SendBestEffortRoomEnvelopeInput<T> extends EnvelopeInput<T> {
        readonly bestEffortFirst?: DirectorCarrier;
    }

    export interface SendOutputEnvelopeInput<T> extends EnvelopeInput<T> {
        /** The relay's edge-ordered output channel. */
        readonly channel: RallarTypedMessageChannel<RallarDirectorRelayEnvelope<T>>;
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
                    purpose: 'command',
                    access: 'members'
                })
                .send(createEnvelope(input), {
                    ack: 'group-leader',
                    strategy: 'rtc-with-ws-fallback',
                    ...(input.claim === undefined
                        ? {}
                        : { ownership: 'exclusive', resourceId: input.claim.resourceId, ttlMs: input.claim.ttlMs })
                });
            return await readDirectorReceipt(receipt, toDirectorReceiptWaitMs(input.claim));
        }
        catch (error) {
            if (!isRallarValidationError(error)) {
                throw error;
            }
            return { status: 'failed', reason: error.message };
        }
    }

    public async sendOutputEnvelope<T>(
        input: BrowserDirectorRelayTransport.SendOutputEnvelopeInput<T>
    ): Promise<RallarDirectorRelaySendResult> {
        const rejection = this.readRoomSendRejection(input.current);
        if (rejection) {
            return rejection;
        }
        const delivery = toOutputDelivery(input.ack);
        const receipt = await input.channel.send(createEnvelope(input), {
            roomRef: requireRoomRef(input.current),
            strategy: 'rtc-with-ws-fallback',
            ...delivery
        });
        const outcome = await receipt.wait({ until: AL_DELIVERY_ADMITTED_STATES, timeoutMs: delivery.ttlMs });
        return isSuccessfulDirectorDelivery(outcome.lifecycle)
            ? { status: 'sent', receipt }
            : { status: 'failed', receipt, reason: outcome.lifecycle.evidence.reason };
    }

    public async sendBestEffortRoomEnvelope<T>(
        input: BrowserDirectorRelayTransport.SendBestEffortRoomEnvelopeInput<T>
    ): Promise<RallarDirectorRelaySendResult> {
        const rejection = this.readRoomSendRejection(input.current);
        return rejection ?? await this.sendOverCarriers(input, requireRoomRef(input.current));
    }

    private async sendOverCarriers<T>(
        input: BrowserDirectorRelayTransport.SendBestEffortRoomEnvelopeInput<T>,
        roomRef: GroupRef
    ): Promise<RallarDirectorRelaySendResult> {
        const message = {
            roomRef,
            topicId: input.topicId,
            typeId: input.typeId,
            payload: createEnvelope(input),
            reliability: 'best-effort' as const,
            ack: 'none' as const,
            ttlMs: DIRECTOR_BEST_EFFORT_TTL_MS
        };
        const wait = { until: AL_DELIVERY_ADMITTED_STATES, timeoutMs: message.ttlMs };
        const sends: Partial<Record<DirectorCarrier, RallarMessageHandle>> = {};
        let reason: string | undefined;
        for (const carrier of this.resolveBestEffortCarriers(input.bestEffortFirst)) {
            const send = await this.input.messages[carrier].send(message);
            sends[carrier] = send;
            const outcome = (await send.wait(wait)).lifecycle;
            if (isSuccessfulDirectorDelivery(outcome)) {
                return { status: 'sent', ...sends };
            }
            reason = outcome.evidence.reason ?? reason;
            // An explicit room refusal cannot be bypassed on the peer connection.
            if (carrier === 'ws' && isRoomRefusal(outcome)) {
                return { status: 'failed', ...sends, reason };
            }
        }
        return { status: 'failed', ...sends, reason };
    }

    /** A WS-first send whose socket is down goes over RTC alone: its queued WS frame would reach no member now. */
    private resolveBestEffortCarriers(first: DirectorCarrier | undefined): readonly DirectorCarrier[] {
        if (first !== 'ws') {
            return ['rtc', 'ws'];
        }
        return this.input.isWebSocketDown() ? ['rtc'] : ['ws', 'rtc'];
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

/** A claiming intent lives no longer than its claim, so its confirmation is awaited no longer either. */
function toDirectorReceiptWaitMs(claim: RallarDirectorRelayClaim | undefined): number {
    const commandTtlMs = AL_CHANNEL_SEND_DEFAULTS.command.ttlMs;
    return claim === undefined ? commandTtlMs : Math.min(claim.ttlMs, commandTtlMs);
}

/**
 * The room's leader confirms a command; a room without one refuses it `no-leader` on either carrier (D167), and the
 * server refuses an intent claiming a resource another session holds `held-by-other` (D176).
 */
async function readDirectorReceipt(
    receipt: RallarMessageHandle,
    timeoutMs: number
): Promise<RallarDirectorRelaySendResult> {
    const outcome = await receipt.wait({ until: ['acknowledged'], timeoutMs });
    const lifecycle = outcome.lifecycle;
    if (lifecycle.state === 'acknowledged') {
        return { status: 'sent', receipt };
    }
    return {
        status: toDirectorCommandFailureStatus(lifecycle.evidence.failure),
        receipt,
        reason: lifecycle.evidence.reason ?? DIRECTOR_COMMAND_UNCONFIRMED_REASON
    };
}

function toDirectorCommandFailureStatus(
    failure: ALDeliveryFailure | undefined
): Extract<RallarDirectorRelaySendStatus, 'no-director' | 'held-by-other' | 'failed'> {
    switch (failure?.kind) {
        case 'refused':
            return failure.reason === 'no-leader' ? 'no-director' : 'failed';
        case 'relay-rejected':
            if (failure.rejection.reason === 'no-leader') {
                return 'no-director';
            }
            return failure.rejection.reason === 'held-by-other' ? 'held-by-other' : 'failed';
        default:
            return 'failed';
    }
}

function createEnvelope<T>(input: BrowserDirectorRelayTransport.EnvelopeInput<T>): RallarDirectorRelayEnvelope<T> {
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

function requireRoomRef(current: RallarDirectorStatus): GroupRef {
    if (!current.roomRef) {
        throw new Error('Validated director room target is missing.');
    }
    return current.roomRef;
}

/** A receipted output is retried for the default message lifetime; an unreceipted one is sent once, best effort. */
function toOutputDelivery(ack: RallarDirectorOutputOptions['ack'] | undefined) {
    return ack === undefined
        ? { reliability: 'best-effort' as const, ack: 'none' as const, ttlMs: DIRECTOR_BEST_EFFORT_TTL_MS }
        : { reliability: 'at-least-once' as const, ack, ttlMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS };
}

function isRoomRefusal(lifecycle: ALDeliveryLifecycle): boolean {
    const kind = lifecycle.evidence.failure?.kind;
    return kind === 'refused' || kind === 'relay-rejected';
}

function isSuccessfulDirectorDelivery(lifecycle: ALDeliveryLifecycle): boolean {
    // A newer intent replaced it; falling back over WS would resend stale state.
    return isALDeliveryAdmitted(lifecycle) || lifecycle.state === 'superseded';
}
