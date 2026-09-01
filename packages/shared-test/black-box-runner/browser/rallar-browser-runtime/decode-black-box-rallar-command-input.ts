import type { ALAckMode } from '@shared/al-contracts/al-contract.ts';

import type {
    BlackBoxRallarRoomRef,
    BlackBoxRallarScope,
    BlackBoxRallarSendInput,
    BlackBoxRallarTransport
} from './black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarWsSendInput } from './black-box-rallar-runtime-contract.ts';

export function isBlackBoxCommandRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function decodeBlackBoxCommandString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function decodeBlackBoxCommandNumber(value: unknown): number | undefined {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined;
    return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}

export function decodeBlackBoxCommandScope(value: unknown): BlackBoxRallarScope | undefined {
    if (!isBlackBoxCommandRecord(value)) {
        return undefined;
    }
    return {
        applicationId: decodeBlackBoxCommandString(value.applicationId),
        workspaceId: decodeBlackBoxCommandString(value.workspaceId)
    };
}

export function decodeBlackBoxCommandRoomRef(value: unknown): BlackBoxRallarRoomRef | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isBlackBoxCommandRecord(value)) {
        throw new Error('Rallar command roomRef must be an object.');
    }
    const applicationId = decodeBlackBoxCommandString(value.applicationId);
    const groupId = decodeBlackBoxCommandString(value.groupId);
    if (!applicationId || !groupId) {
        throw new Error('Rallar command roomRef requires applicationId and groupId.');
    }
    return { applicationId, groupId, workspaceId: decodeBlackBoxCommandString(value.workspaceId) };
}

function decodePeerIds(value: unknown): readonly string[] | undefined {
    return Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')
        ? value
        : undefined;
}

function decodeAck(value: unknown): ALAckMode | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (value === 'none' || value === 'receiver' || value === 'all-logical-recipients' || value === 'group-leader') {
        return value;
    }
    throw new Error('Rallar command ack mode is invalid.');
}

function decodeMessageFields(record: Record<string, unknown>): BlackBoxRallarSendInput {
    return {
        ...('payload' in record ? { payload: record.payload } : {}),
        ...('data' in record ? { data: record.data } : {}),
        roomId: decodeBlackBoxCommandString(record.roomId),
        roomRef: decodeBlackBoxCommandRoomRef(record.roomRef),
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
        ack: decodeAck(record.ack),
        ownership: record.ownership === 'shared' || record.ownership === 'exclusive' ? record.ownership : undefined,
        minSnapshotVersion: decodeBlackBoxCommandNumber(record.minSnapshotVersion)
    };
}

function isRealtimeSendEnvelope(input: Record<string, unknown>): boolean {
    return [
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
    ]
        .some((field) => field in input);
}

export function decodeBlackBoxRallarSendInput(
    input: unknown,
    transport: BlackBoxRallarTransport
): BlackBoxRallarSendInput {
    if (!isBlackBoxCommandRecord(input) || (transport === 'realtime' && !isRealtimeSendEnvelope(input))) {
        return transport === 'realtime' ? { data: input } : { payload: input };
    }
    return {
        ...decodeMessageFields(input),
        laneId: decodeBlackBoxCommandString(input.laneId),
        peerIds: decodePeerIds(input.peerIds),
        nextHopPeerIds: decodePeerIds(input.nextHopPeerIds),
        remotePeerId: decodeBlackBoxCommandString(input.remotePeerId),
        membershipEpoch: decodeBlackBoxCommandNumber(input.membershipEpoch),
        seq: decodeBlackBoxCommandNumber(input.seq),
        orderingKey: decodeBlackBoxCommandString(input.orderingKey),
        overlayId: decodeBlackBoxCommandString(input.overlayId),
        fanoutLimit: decodeBlackBoxCommandNumber(input.fanoutLimit),
        openTimeoutMs: decodeBlackBoxCommandNumber(input.openTimeoutMs),
        key: decodeBlackBoxCommandString(input.key),
        maxAgeMs: decodeBlackBoxCommandNumber(input.maxAgeMs)
    };
}

export function decodeBlackBoxRallarWsSendInput(input: unknown): BlackBoxRallarWsSendInput {
    if (!isBlackBoxCommandRecord(input)) {
        return { payload: input };
    }
    return {
        ...decodeMessageFields(input),
        scope: input.scope === 'room' || input.scope === 'world' || input.scope === 'all' ? input.scope : undefined,
        groupId: decodeBlackBoxCommandString(input.groupId),
        topic: decodeBlackBoxCommandString(input.topic),
        kind: decodeBlackBoxCommandString(input.kind),
        exceptPeerIds: decodePeerIds(input.exceptPeerIds)
    };
}
