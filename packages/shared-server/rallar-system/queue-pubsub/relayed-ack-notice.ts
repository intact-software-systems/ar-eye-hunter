import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { WsServerAckRelayPublisher } from '@shared/services/ws-queue-box-server/ws-queue-box-server-ack-relay.ts';
import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '../protocol/json-wire-identity.ts';
import { MAX_LIVE_WS_NOTICE_BYTES } from './live-ws-notice.ts';

const RELAYED_ACK_NOTICE_KEYS = ['kind', 'version', 'channel', 'publisherId', 'message'] as const;

/** One receiver ACK handed from the instance whose socket received it to the instance holding its aggregate. */
export interface RelayedAckNotice {
    readonly kind: 'relayed-ack';
    readonly version: 1;
    readonly channel: string;
    readonly publisherId: string;
    readonly message: ALMessage;
}

export interface RelayedAckNoticeTransport {
    publish(notice: RelayedAckNotice): Promise<void>;
    subscribe(
        channel: string,
        onNotice: (notice: RelayedAckNotice) => Promise<void> | void
    ): Promise<void>;
}

export interface RelayedAckNoticeChannel {
    readonly transport: RelayedAckNoticeTransport;
    readonly channel: string;
    readonly publisherId: string;
}

export interface ToRelayedAckNoticeInput {
    readonly channel: string;
    readonly publisherId: string;
    readonly message: ALMessage;
}

/** The notice for one receiver ACK, or why it cannot travel: not an ACK, or at the notification byte limit. */
export function toRelayedAckNotice(
    input: ToRelayedAckNoticeInput
): Either<string, RelayedAckNotice> {
    const control = decodeALControlMessage(input.message);
    if (control.left || control.right?.type !== 'ack') {
        return Either.ofLeft('Only a receiver acknowledgement is relayed');
    }
    const notice: RelayedAckNotice = {
        kind: 'relayed-ack',
        version: 1,
        channel: input.channel,
        publisherId: input.publisherId,
        message: input.message
    };
    const bytes = new TextEncoder().encode(JSON.stringify(notice)).length;
    return bytes < MAX_LIVE_WS_NOTICE_BYTES
        ? Either.ofRight(notice)
        : Either.ofLeft(`Relayed acknowledgement notice is oversized (${bytes} bytes)`);
}

/** A relayed-ACK notice on the expected channel; anything else, a live WS notice included, is not one. */
export function decodeRelayedAckNotice(
    value: unknown,
    expectedChannel: string
): RelayedAckNotice | undefined {
    let wire: JsonWireValue;
    try {
        wire = decodeJsonWireValue(value, 'Relayed acknowledgement notice');
    }
    catch {
        return undefined;
    }
    if (
        !isRelayedAckNoticeRecord(wire) || wire.channel !== expectedChannel ||
        new TextEncoder().encode(JSON.stringify(wire)).length >= MAX_LIVE_WS_NOTICE_BYTES
    ) {
        return undefined;
    }
    const message = decodeALMessageValue(wire.message).right;
    return message === undefined
        ? undefined
        : toRelayedAckNotice({ channel: expectedChannel, publisherId: wire.publisherId, message })
            .right;
}

/** The WS service's relay port over one notice channel. */
export function createRelayedAckPublisher(
    channel: RelayedAckNoticeChannel
): WsServerAckRelayPublisher {
    return async (message) => {
        const notice = toRelayedAckNotice({
            channel: channel.channel,
            publisherId: channel.publisherId,
            message
        });
        if (notice.left !== undefined) {
            return Either.ofLeft(notice.left);
        }
        try {
            await channel.transport.publish(notice.right!);
            return Either.ofRight('published');
        }
        catch (error) {
            return Either.ofLeft(error instanceof Error ? error.message : String(error));
        }
    };
}

function isRelayedAckNoticeRecord(
    wire: JsonWireValue
): wire is
    & JsonWireObject
    & Readonly<{ channel: string; publisherId: string; message: JsonWireValue; }> {
    if (!isJsonWireRecord(wire)) {
        return false;
    }
    return Object.keys(wire).length === RELAYED_ACK_NOTICE_KEYS.length &&
        RELAYED_ACK_NOTICE_KEYS.every((key) => Object.hasOwn(wire, key)) &&
        wire.kind === 'relayed-ack' && wire.version === 1 && typeof wire.channel === 'string' &&
        typeof wire.publisherId === 'string' && wire.publisherId.length > 0;
}

function isJsonWireRecord(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
