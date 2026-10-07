import { AL_DURABILITY_ALGOS } from '@shared/al-contracts/al-policy.ts';
import type { ALAckAlgo } from '@shared/al-contracts/al-policy.ts';
import type { ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { Either } from '@shared/resilience/Either.ts';

import type {
    BlackBoxRallarMessageReplayInput,
    BlackBoxRallarMessageReplayTarget,
    BlackBoxRallarMessageSendInput,
    BlackBoxRallarMessageSnapshotFloor
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

type MessageSendOptions = Pick<
    BlackBoxRallarMessageSendInput,
    'roomRef' | 'scope' | 'reliability' | 'ack' | 'durability' | 'onStorageUnavailable' | 'minSnapshotVersion' | 'qos'
>;

type MessageSendAudience = Pick<BlackBoxRallarMessageSendInput, 'toPeer' | 'principalId' | 'recipientPeer'>;

const MESSAGE_CARRIERS: readonly BlackBoxRallarMessageSendInput['carrier'][] = ['ws', 'rtc', 'rtc-with-ws-fallback'];
const MESSAGE_SCOPES: readonly NonNullable<BlackBoxRallarMessageSendInput['scope']>[] = ['room', 'world', 'principal'];
const MESSAGE_RELIABILITIES: readonly NonNullable<BlackBoxRallarMessageSendInput['reliability']>[] = [
    'best-effort',
    'at-least-once'
];
const QOS_ACK_ALGOS: readonly ALAckAlgo[] = ['none', 'hop', 'subtree', 'receiver'];
const ON_STORAGE_UNAVAILABLE: readonly NonNullable<BlackBoxRallarMessageSendInput['onStorageUnavailable']>[] = [
    'refuse',
    'volatile'
];
const REPLAY_CARRIERS: readonly ALDeliveryCarrier[] = ['ws', 'rtc'];
const MESSAGE_PEER_ROLES: readonly NonNullable<BlackBoxRallarMessageSendInput['toPeer']>[] = [
    'server',
    'receiver'
];
const MESSAGE_RECIPIENT_PEER_ROLES: readonly NonNullable<BlackBoxRallarMessageSendInput['recipientPeer']>[] = [
    'receiver'
];
/** Every field an ordinary send names and a replay does not: the replayed envelope already fixes them all. */
const REPLAY_REFUSED_FIELDS = [
    'carrier',
    'typeId',
    'topicId',
    'payload',
    'roomRef',
    'scope',
    'principalId',
    'recipientPeer',
    'reliability',
    'ack',
    'durability',
    'onStorageUnavailable',
    'ttlMs',
    'orderingKey',
    'seq',
    'handleId',
    'minSnapshotVersion',
    'qos',
    'toPeer'
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
    return decodeMessageAudience(value).flatMap(
        (issue) => Either.ofLeft(issue),
        (peer) =>
            decodeMessageSendIdentity(value).flatMap(
                (issue) => Either.ofLeft(issue),
                (identity) =>
                    decodeMessageSendOptions(value).mapRight((options) => ({
                        ...identity,
                        ...options,
                        ...peer,
                        payload,
                        topicId: decodeBlackBoxCommandString(value.topicId),
                        ttlMs: decodeBlackBoxCommandNumber(value.ttlMs),
                        orderingKey: decodeBlackBoxCommandString(value.orderingKey),
                        seq: decodeBlackBoxCommandNumber(value.seq)
                    }))
            )
    );
}

function decodeMessageAudience(
    record: BlackBoxRallarCommandRecord
): Either<BlackBoxRallarInputIssue, MessageSendAudience> {
    const toPeer = MESSAGE_PEER_ROLES.find((role) => role === record.toPeer);
    if (record.toPeer !== undefined && toPeer === undefined) {
        return Either.ofLeft({ message: 'messages.send.toPeer must be server or receiver.' });
    }
    const recipientPeer = MESSAGE_RECIPIENT_PEER_ROLES.find((role) => role === record.recipientPeer);
    if (record.recipientPeer !== undefined && recipientPeer === undefined) {
        return Either.ofLeft({ message: 'messages.send.recipientPeer must be receiver.' });
    }
    return Either.ofRight({ toPeer, principalId: decodeBlackBoxCommandString(record.principalId), recipientPeer });
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

/** A null scope, reliability, durability or storage choice reads as absent, the way the recipe schema writes an unset option. */
function decodeMessageSendOptions(
    record: BlackBoxRallarCommandRecord
): Either<BlackBoxRallarInputIssue, MessageSendOptions> {
    const scope = decodeKnownSendOption(record.scope, MESSAGE_SCOPES, 'scope must be room, world, or principal');
    const reliability = decodeKnownSendOption(
        record.reliability,
        MESSAGE_RELIABILITIES,
        'reliability must be best-effort or at-least-once'
    );
    const durability = decodeKnownSendOption(
        record.durability,
        AL_DURABILITY_ALGOS,
        'durability must be volatile, local-checkpoint, local-outbox or local-inbox'
    );
    const onStorageUnavailable = decodeKnownSendOption(
        record.onStorageUnavailable,
        ON_STORAGE_UNAVAILABLE,
        'onStorageUnavailable must be refuse or volatile'
    );
    const minSnapshotVersion = decodeMessageSnapshotFloor(record.minSnapshotVersion);
    const qos = decodeMessageQos(record.qos);
    return decodeBlackBoxCommandRouting(record).flatMap(
        (issue) => Either.ofLeft(issue),
        (routing) => {
            if (isInputIssue(scope)) {
                return Either.ofLeft(scope);
            }
            if (isInputIssue(reliability)) {
                return Either.ofLeft(reliability);
            }
            if (isInputIssue(durability)) {
                return Either.ofLeft(durability);
            }
            if (isInputIssue(onStorageUnavailable)) {
                return Either.ofLeft(onStorageUnavailable);
            }
            if (isInputIssue(minSnapshotVersion)) {
                return Either.ofLeft(minSnapshotVersion);
            }
            if (isInputIssue(qos)) {
                return Either.ofLeft(qos);
            }
            return Either.ofRight({
                ...routing,
                scope,
                reliability,
                durability,
                onStorageUnavailable,
                minSnapshotVersion,
                qos
            });
        }
    );
}

function decodeKnownSendOption<T extends string>(
    value: unknown,
    allowed: readonly T[],
    rule: string
): T | BlackBoxRallarInputIssue | undefined {
    const known = allowed.find((candidate) => candidate === value);
    return value === undefined || value === null || known !== undefined ? known : { message: `messages.send.${rule}.` };
}

function isInputIssue<T>(value: T | BlackBoxRallarInputIssue): value is BlackBoxRallarInputIssue {
    return typeof value === 'object' && value !== null && 'message' in value;
}

/** Absent, the send states no floor of its own. */
function decodeMessageSnapshotFloor(
    value: unknown
): BlackBoxRallarMessageSnapshotFloor | BlackBoxRallarInputIssue | undefined {
    if (value === undefined) {
        return undefined;
    }
    const floor = isBlackBoxCommandRecord(value) ? value : {};
    const keys = Object.keys(floor);
    const amount = floor.absolute ?? floor.aboveCurrentBy;
    if (keys.length !== 1 || typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1) {
        return {
            message: 'messages.send.minSnapshotVersion must name exactly one of absolute or aboveCurrentBy, as a ' +
                'positive integer.'
        };
    }
    return keys[0] === 'absolute' ? { absolute: amount } : { aboveCurrentBy: amount };
}

/** Absent, the product normalizes the QoS the delivery options imply. */
function decodeMessageQos(value: unknown): BlackBoxRallarMessageSendInput['qos'] | BlackBoxRallarInputIssue {
    if (value === undefined) {
        return undefined;
    }
    const qos = isBlackBoxCommandRecord(value) ? value : {};
    const ack = isBlackBoxCommandRecord(qos.ack) ? qos.ack : {};
    const algo = QOS_ACK_ALGOS.find((candidate) => candidate === ack.algo);
    if (Object.keys(qos).length !== 1 || Object.keys(ack).length !== 1 || algo === undefined) {
        return {
            message: 'messages.send.qos must name exactly ack, with an algo of none, hop, subtree or receiver.'
        };
    }
    return { ack: { algo } };
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
