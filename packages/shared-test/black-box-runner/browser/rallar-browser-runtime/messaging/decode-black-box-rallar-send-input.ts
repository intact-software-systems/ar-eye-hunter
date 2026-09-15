import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { BlackBoxRallarSendInput } from '../black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarWsSendInput } from '../black-box-rallar-runtime-contract.ts';
import {
    decodeBlackBoxCommandNumber,
    decodeBlackBoxCommandRouting,
    decodeBlackBoxCommandScope,
    decodeBlackBoxCommandString,
    isBlackBoxCommandRecord,
    isRallarMessagePayload,
    type BlackBoxRallarCommandRecord,
    type BlackBoxRallarInputIssue
} from '../decode-black-box-rallar-command-input.ts';

/** A send the page boundary classified: an envelope, decoded once the transport of the connection is known, or a bare payload. */
export type BlackBoxRallarSendCommand =
    | { readonly kind: 'envelope'; readonly envelope: BlackBoxRallarCommandRecord; }
    | { readonly kind: 'payload'; readonly payload: RallarMessagePayload; };

export type BlackBoxRallarSendTransport = 'realtime' | 'messages.rtc';

const REALTIME_ENVELOPE_FIELDS: readonly string[] = [
    'data',
    'laneId',
    'roomId',
    'roomRef',
    'applicationId',
    'workspaceId',
    'scope',
    'peerIds',
    'nextHopPeerIds',
    'remotePeerId',
    'typeId',
    'topicId',
    'contextId',
    'resourceId'
];
const ENVELOPE_PAYLOAD_FIELDS = ['payload', 'data'] as const;
const WEB_SOCKET_SCOPES: readonly NonNullable<BlackBoxRallarWsSendInput['scope']>[] = ['room', 'world', 'all'];

export function decodeBlackBoxRallarSendCommand(
    value: unknown
): Either<BlackBoxRallarInputIssue, BlackBoxRallarSendCommand> {
    if (isBlackBoxCommandRecord(value)) {
        return Either.ofRight({ kind: 'envelope', envelope: value });
    }
    return isRallarMessagePayload(value)
        ? Either.ofRight({ kind: 'payload', payload: value })
        : Either.ofLeft({ message: 'Rallar send requires a message payload.' });
}

/** A realtime record naming no envelope field is itself the data; a messages.rtc record is always an envelope. */
export function decodeBlackBoxRallarSendInput(
    command: BlackBoxRallarSendCommand,
    transport: BlackBoxRallarSendTransport
): Either<BlackBoxRallarInputIssue, BlackBoxRallarSendInput> {
    if (command.kind === 'payload') {
        return Either.ofRight(transport === 'realtime' ? { data: command.payload } : { payload: command.payload });
    }
    const envelope = command.envelope;
    if (transport === 'realtime' && !REALTIME_ENVELOPE_FIELDS.some((field) => field in envelope)) {
        return Either.ofRight({ data: envelope });
    }
    return decodeMessageFields(envelope).mapRight((fields) => ({
        ...fields,
        laneId: decodeBlackBoxCommandString(envelope.laneId),
        peerIds: decodePeerIds(envelope.peerIds),
        nextHopPeerIds: decodePeerIds(envelope.nextHopPeerIds),
        remotePeerId: decodeBlackBoxCommandString(envelope.remotePeerId),
        membershipEpoch: decodeBlackBoxCommandNumber(envelope.membershipEpoch),
        seq: decodeBlackBoxCommandNumber(envelope.seq),
        orderingKey: decodeBlackBoxCommandString(envelope.orderingKey),
        overlayId: decodeBlackBoxCommandString(envelope.overlayId),
        fanoutLimit: decodeBlackBoxCommandNumber(envelope.fanoutLimit),
        openTimeoutMs: decodeBlackBoxCommandNumber(envelope.openTimeoutMs),
        key: decodeBlackBoxCommandString(envelope.key),
        maxAgeMs: decodeBlackBoxCommandNumber(envelope.maxAgeMs)
    }));
}

/** A record naming neither payload nor data is itself the payload, as is any bare value. */
export function decodeBlackBoxRallarWsSendInput(
    value: unknown
): Either<BlackBoxRallarInputIssue, BlackBoxRallarWsSendInput> {
    if (!isBlackBoxCommandRecord(value)) {
        return isRallarMessagePayload(value)
            ? Either.ofRight({ payload: value })
            : Either.ofLeft({ message: 'ws.send requires a message payload.' });
    }
    return decodeMessageFields(value).mapRight((fields) => ({
        ...fields,
        payload: fields.payload !== undefined ? fields.payload : fields.data !== undefined ? fields.data : value,
        scope: WEB_SOCKET_SCOPES.find((scope) => scope === value.scope),
        groupId: decodeBlackBoxCommandString(value.groupId),
        topic: decodeBlackBoxCommandString(value.topic),
        kind: decodeBlackBoxCommandString(value.kind),
        exceptPeerIds: decodePeerIds(value.exceptPeerIds)
    }));
}

function decodeMessageFields(
    record: BlackBoxRallarCommandRecord
): Either<BlackBoxRallarInputIssue, BlackBoxRallarSendInput> {
    const invalidPayloadField = ENVELOPE_PAYLOAD_FIELDS.find((field) =>
        field in record && !isRallarMessagePayload(record[field])
    );
    if (invalidPayloadField !== undefined) {
        return Either.ofLeft({ message: `Rallar send ${invalidPayloadField} must be a message payload.` });
    }
    const payload = record.payload;
    const data = record.data;
    return decodeBlackBoxCommandRouting(record).mapRight((routing) => ({
        ...('payload' in record && isRallarMessagePayload(payload) ? { payload } : {}),
        ...('data' in record && isRallarMessagePayload(data) ? { data } : {}),
        ...routing,
        roomId: decodeBlackBoxCommandString(record.roomId),
        applicationId: decodeBlackBoxCommandString(record.applicationId),
        workspaceId: decodeBlackBoxCommandString(record.workspaceId),
        scope: decodeBlackBoxCommandScope(record.scope),
        typeId: decodeBlackBoxCommandString(record.typeId),
        topicId: decodeBlackBoxCommandString(record.topicId),
        contextId: decodeBlackBoxCommandString(record.contextId),
        resourceId: decodeBlackBoxCommandString(record.resourceId),
        ttlHops: decodeBlackBoxCommandNumber(record.ttlHops),
        ttlMs: decodeBlackBoxCommandNumber(record.ttlMs),
        reliability: record.reliability === 'best-effort' || record.reliability === 'at-least-once'
            ? record.reliability
            : undefined,
        ownership: record.ownership === 'shared' || record.ownership === 'exclusive' ? record.ownership : undefined,
        minSnapshotVersion: decodeBlackBoxCommandNumber(record.minSnapshotVersion)
    }));
}

function decodePeerIds(value: unknown): readonly string[] | undefined {
    return Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')
        ? value
        : undefined;
}
