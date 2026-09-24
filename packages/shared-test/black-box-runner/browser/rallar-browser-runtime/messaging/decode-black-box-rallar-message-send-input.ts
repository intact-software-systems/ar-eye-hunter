import type { ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { Either } from '@shared/resilience/Either.ts';

import type {
    BlackBoxRallarMessageReplayInput,
    BlackBoxRallarMessageReplayTarget,
    BlackBoxRallarMessageSendInput
} from '../black-box-rallar-operation-contracts.ts';
import {
    decodeBlackBoxCommandNumber,
    decodeBlackBoxCommandRouting,
    decodeBlackBoxCommandString,
    isBlackBoxCommandRecord,
    isRallarMessagePayload,
    type BlackBoxRallarCommandRecord,
    type BlackBoxRallarInputIssue
} from '../decode-black-box-rallar-command-input.ts';

type MessageSendIdentity = Pick<
    BlackBoxRallarMessageSendInput,
    'timeoutMs' | 'connection' | 'carrier' | 'typeId' | 'handleId'
>;

type MessageSendOptions = Pick<BlackBoxRallarMessageSendInput, 'roomRef' | 'scope' | 'reliability' | 'ack'>;

const MESSAGE_CARRIERS: readonly BlackBoxRallarMessageSendInput['carrier'][] = ['ws', 'rtc', 'rtc-with-ws-fallback'];
const MESSAGE_SCOPES: readonly NonNullable<BlackBoxRallarMessageSendInput['scope']>[] = ['room', 'world', 'all'];
const MESSAGE_RELIABILITIES: readonly NonNullable<BlackBoxRallarMessageSendInput['reliability']>[] = [
    'best-effort',
    'at-least-once'
];
const REPLAY_CARRIERS: readonly ALDeliveryCarrier[] = ['ws', 'rtc'];
/** Every field an ordinary send names and a replay does not: the replayed envelope already fixes them all. */
const REPLAY_REFUSED_FIELDS = [
    'carrier',
    'typeId',
    'topicId',
    'payload',
    'roomRef',
    'scope',
    'reliability',
    'ack',
    'ttlMs',
    'orderingKey',
    'seq',
    'handleId'
] as const;

type MessageSendCommandInput = BlackBoxRallarMessageSendInput | BlackBoxRallarMessageReplayInput;

export function decodeBlackBoxRallarMessageSendInput(
    value: unknown
): Either<BlackBoxRallarInputIssue, MessageSendCommandInput> {
    if (!isBlackBoxCommandRecord(value)) {
        return Either.ofLeft({ message: 'messages.send input must be an object.' });
    }
    return value.replayOnCarrier === undefined ? decodeOrdinarySend(value) : decodeReplaySend(value);
}

function decodeReplaySend(
    record: BlackBoxRallarCommandRecord
): Either<BlackBoxRallarInputIssue, BlackBoxRallarMessageReplayInput> {
    const named = REPLAY_REFUSED_FIELDS.filter((field) => record[field] !== undefined);
    if (named.length > 0) {
        return Either.ofLeft({
            message: `messages.send names ${named.join(', ')} beside replayOnCarrier; a replay names only the handle ` +
                'and its carrier.'
        });
    }
    const timeoutMs = decodeBlackBoxCommandNumber(record.timeoutMs);
    const connection = decodeBlackBoxCommandString(record.connection);
    if (timeoutMs === undefined || connection === undefined) {
        return Either.ofLeft({ message: 'messages.send replay requires timeoutMs and connection.' });
    }
    return decodeMessageReplayTarget(record.replayOnCarrier).mapRight((replayOnCarrier) => ({
        timeoutMs,
        connection,
        replayOnCarrier
    }));
}

function decodeOrdinarySend(
    value: BlackBoxRallarCommandRecord
): Either<BlackBoxRallarInputIssue, BlackBoxRallarMessageSendInput> {
    const payload = value.payload;
    if (!('payload' in value) || !isRallarMessagePayload(payload)) {
        return Either.ofLeft({ message: 'messages.send.payload is required.' });
    }
    return decodeMessageSendIdentity(value).flatMap(
        (issue) => Either.ofLeft(issue),
        (identity) =>
            decodeMessageSendOptions(value).mapRight((options) => ({
                ...identity,
                ...options,
                payload,
                topicId: decodeBlackBoxCommandString(value.topicId),
                ttlMs: decodeBlackBoxCommandNumber(value.ttlMs),
                orderingKey: decodeBlackBoxCommandString(value.orderingKey),
                seq: decodeBlackBoxCommandNumber(value.seq)
            }))
    );
}

function decodeMessageSendIdentity(
    record: BlackBoxRallarCommandRecord
): Either<BlackBoxRallarInputIssue, MessageSendIdentity> {
    const timeoutMs = decodeBlackBoxCommandNumber(record.timeoutMs);
    if (timeoutMs === undefined) {
        return Either.ofLeft({ message: 'messages.send.timeoutMs is required.' });
    }
    const connection = decodeBlackBoxCommandString(record.connection);
    if (connection === undefined) {
        return Either.ofLeft({ message: 'messages.send.connection is required.' });
    }
    const carrier = MESSAGE_CARRIERS.find((candidate) => candidate === record.carrier);
    if (carrier === undefined) {
        return Either.ofLeft({ message: 'messages.send.carrier must be ws, rtc, or rtc-with-ws-fallback.' });
    }
    const typeId = decodeBlackBoxCommandString(record.typeId);
    if (typeId === undefined) {
        return Either.ofLeft({ message: 'messages.send.typeId is required.' });
    }
    const handleId = decodeBlackBoxCommandString(record.handleId);
    return handleId === undefined
        ? Either.ofLeft({ message: 'messages.send.handleId is required.' })
        : Either.ofRight({ timeoutMs, connection, carrier, typeId, handleId });
}

/** A null scope or reliability reads as absent, the way the recipe schema writes an unset option. */
function decodeMessageSendOptions(
    record: BlackBoxRallarCommandRecord
): Either<BlackBoxRallarInputIssue, MessageSendOptions> {
    const scope = record.scope ?? undefined;
    const reliability = record.reliability ?? undefined;
    const knownScope = MESSAGE_SCOPES.find((candidate) => candidate === scope);
    const knownReliability = MESSAGE_RELIABILITIES.find((candidate) => candidate === reliability);
    return decodeBlackBoxCommandRouting(record).flatMap(
        (issue) => Either.ofLeft(issue),
        (routing) => {
            if (scope !== undefined && knownScope === undefined) {
                return Either.ofLeft({ message: 'messages.send.scope must be room, world, or all.' });
            }
            if (reliability !== undefined && knownReliability === undefined) {
                return Either.ofLeft({ message: 'messages.send.reliability must be best-effort or at-least-once.' });
            }
            return Either.ofRight({ ...routing, scope: knownScope, reliability: knownReliability });
        }
    );
}

function decodeMessageReplayTarget(
    value: unknown
): Either<BlackBoxRallarInputIssue, BlackBoxRallarMessageReplayTarget> {
    const replay = isBlackBoxCommandRecord(value) ? value : {};
    const handleId = decodeBlackBoxCommandString(replay.handleId);
    const carrier = REPLAY_CARRIERS.find((candidate) => candidate === replay.carrier);
    return handleId === undefined || carrier === undefined
        ? Either.ofLeft({ message: 'messages.send.replayOnCarrier must name a handleId and a ws or rtc carrier.' })
        : Either.ofRight({ handleId, carrier });
}
