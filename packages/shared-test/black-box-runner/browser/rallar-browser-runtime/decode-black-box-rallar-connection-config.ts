import type { RallarMessageSelectorInput } from '@shared-web/browser/messages/rallar-message-selectors.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/web-rtc-connection-service.ts';
import type { RtcDataChannelFlowControlPolicy } from '@shared/webrtc/qrtc-data-channel.ts';
import type { BlackBoxRallarConfig, BlackBoxRallarConnectionConfig } from './black-box-rallar-operation-contracts.ts';
import { decodeBlackBoxCommandRoomRef, isBlackBoxCommandRecord } from './decode-black-box-rallar-command-input.ts';

function configRecord(value: unknown): Record<string, unknown> {
    if (!isBlackBoxCommandRecord(value)) {
        throw new TypeError('Rallar connection configuration must be an object.');
    }
    return value;
}

function optionalString(value: unknown): string | undefined {
    if (value === undefined || typeof value === 'string') {
        return value;
    }
    throw new TypeError('Rallar connection option must be a string.');
}

function optionalNumber(value: unknown): number | undefined {
    if (value === undefined || (typeof value === 'number' && Number.isFinite(value))) {
        return value;
    }
    throw new TypeError('Rallar connection option must be a finite number.');
}

function optionalBoolean(value: unknown): boolean | undefined {
    if (value === undefined || typeof value === 'boolean') {
        return value;
    }
    throw new TypeError('Rallar connection option must be boolean.');
}

function optionalChoice<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
    if (value === undefined) {
        return undefined;
    }
    const choice = choices.find((candidate) => candidate === value);
    if (choice === undefined) {
        throw new TypeError('Rallar connection option has an unsupported value.');
    }
    return choice;
}

function stringList(value: unknown): readonly string[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
        throw new TypeError('Rallar connection option must be an array of strings.');
    }
    return value;
}

function registration(value: unknown): boolean | 'if-needed' | undefined {
    return value === 'if-needed' ? value : optionalBoolean(value);
}

function messageSelector(value: unknown): RallarMessageSelectorInput | undefined {
    if (value === undefined || typeof value === 'string') {
        return value;
    }
    const record = configRecord(value);
    return { topicId: optionalString(record.topicId), typeId: optionalString(record.typeId) };
}

function dataChannelInit(value: unknown): RTCDataChannelInit | undefined {
    if (value === undefined) {
        return undefined;
    }
    const record = configRecord(value);
    return {
        id: optionalNumber(record.id),
        ordered: optionalBoolean(record.ordered),
        negotiated: optionalBoolean(record.negotiated),
        maxPacketLifeTime: optionalNumber(record.maxPacketLifeTime),
        maxRetransmits: optionalNumber(record.maxRetransmits),
        protocol: optionalString(record.protocol)
    };
}

function flowControl(value: unknown): RtcDataChannelFlowControlPolicy | undefined {
    if (value === undefined) {
        return undefined;
    }
    const record = configRecord(value);
    const overflow = optionalChoice(record.overflow, ['drop-new', 'drop-old', 'replace-by-key', 'queue']);
    const highWatermarkBytes = optionalNumber(record.highWatermarkBytes);
    const lowWatermarkBytes = optionalNumber(record.lowWatermarkBytes);
    const maxQueueItems = optionalNumber(record.maxQueueItems);
    // Omitted options must not overwrite the transport's defaults with undefined.
    return {
        ...(highWatermarkBytes === undefined ? {} : { highWatermarkBytes }),
        ...(lowWatermarkBytes === undefined ? {} : { lowWatermarkBytes }),
        ...(maxQueueItems === undefined ? {} : { maxQueueItems }),
        ...(overflow === undefined ? {} : { overflow })
    };
}

function dataChannelLanes(value: unknown): readonly RtcDataChannelLaneConfig[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new TypeError('Rallar RTC lanes must be an array.');
    }
    return value.map((item) => {
        const record = configRecord(item);
        const id = optionalString(record.id);
        const label = optionalString(record.label);
        if (id === undefined || label === undefined) {
            throw new TypeError('Rallar RTC lane requires an id and label.');
        }
        return {
            id,
            label,
            binaryType: optionalChoice(record.binaryType, ['blob', 'arraybuffer']),
            init: dataChannelInit(record.init),
            flowControl: flowControl(record.flowControl)
        };
    });
}

/** Shared sparse wire configuration; local CRDT documents need no API endpoint. */
export function decodeBlackBoxRallarConfigFields(value: unknown): Partial<BlackBoxRallarConfig> {
    const record = configRecord(value);
    const scope = record.scope === undefined ? undefined : configRecord(record.scope);
    return {
        apiBaseUrl: optionalString(record.apiBaseUrl),
        applicationId: optionalString(record.applicationId),
        workspaceId: optionalString(record.workspaceId),
        scope: scope === undefined ? undefined : {
            applicationId: optionalString(scope.applicationId),
            workspaceId: optionalString(scope.workspaceId)
        },
        roomRef: decodeBlackBoxCommandRoomRef(record.roomRef),
        username: optionalString(record.username),
        password: optionalString(record.password),
        displayName: optionalString(record.displayName),
        register: registration(record.register),
        transport: optionalChoice(record.transport, ['realtime', 'messages.rtc']),
        laneId: optionalString(record.laneId),
        openTimeoutMs: optionalNumber(record.openTimeoutMs),
        timeoutMs: optionalNumber(record.timeoutMs),
        peerIds: stringList(record.peerIds),
        nextHopPeerIds: stringList(record.nextHopPeerIds),
        typeId: optionalString(record.typeId),
        topicId: optionalString(record.topicId),
        contextId: optionalString(record.contextId),
        resourceId: optionalString(record.resourceId),
        messageSelector: messageSelector(record.messageSelector),
        ttlHops: optionalNumber(record.ttlHops),
        ttlMs: optionalNumber(record.ttlMs),
        reliability: optionalChoice(record.reliability, ['best-effort', 'at-least-once']),
        ack: optionalChoice(record.ack, ['none', 'receiver', 'all-logical-recipients', 'group-leader']),
        ownership: optionalChoice(record.ownership, ['shared', 'exclusive']),
        membershipEpoch: optionalNumber(record.membershipEpoch),
        minSnapshotVersion: optionalNumber(record.minSnapshotVersion),
        seq: optionalNumber(record.seq),
        orderingKey: optionalString(record.orderingKey),
        overlayId: optionalString(record.overlayId),
        fanoutLimit: optionalNumber(record.fanoutLimit),
        dataChannelLanes: dataChannelLanes(record.dataChannelLanes),
        expectedSessionId: optionalString(record.expectedSessionId),
        leaveRoomOnClose: optionalBoolean(record.leaveRoomOnClose),
        logoutOnClose: optionalBoolean(record.logoutOnClose)
    };
}

export function decodeBlackBoxRallarConnectionConfig(value: unknown): BlackBoxRallarConnectionConfig {
    const record = configRecord(value);
    const connection = optionalString(record.connection);
    const rallar = decodeBlackBoxRallarConfigFields(record.rallar);
    if (!connection || !rallar.apiBaseUrl) {
        throw new TypeError('Rallar connection requires connection and rallar.apiBaseUrl.');
    }
    return {
        connection,
        actor: optionalString(record.actor),
        peerId: optionalString(record.peerId),
        remotePeerId: optionalString(record.remotePeerId),
        roomId: optionalString(record.roomId),
        roomRef: decodeBlackBoxCommandRoomRef(record.roomRef),
        rallar: { ...rallar, apiBaseUrl: rallar.apiBaseUrl }
    };
}
