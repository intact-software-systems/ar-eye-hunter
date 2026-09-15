import type {
    RallarRealtimeSendResult,
    RallarRtcSendInput,
    RallarTypedMessageSendOptions,
    RallarWsSendInput
} from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarMessageSendInput,
    BlackBoxRallarSendInput,
    BlackBoxRallarWsSendDiagnostics
} from '../black-box-rallar-operation-contracts.ts';
import {
    blackBoxRallarRoomRefOf,
    blackBoxRallarScopeDiagnosticsOf,
    type BlackBoxRallarScopeDiagnostics
} from '../black-box-rallar-operation-policy.ts';
import type { BlackBoxRallarRuntime } from '../black-box-rallar-runtime-contract.ts';
import {
    resolveBlackBoxRallarTopicId,
    resolveBlackBoxRallarTypeId
} from '../connection/black-box-rallar-connection-policy.ts';
import { decodeBlackBoxRallarWsSendInput } from '../decode-black-box-rallar-command-input.ts';

export interface MessageRoutingDiagnostics {
    readonly roomId: string | undefined;
    readonly roomRef: GroupRef | undefined;
    readonly typeId: string;
    readonly topicId: string | undefined;
    readonly contextId: string | undefined;
    readonly resourceId: string | undefined;
    readonly minSnapshotVersion: number | undefined;
}

export interface RealtimeSendSummary {
    readonly total: number;
    readonly statuses: Readonly<Record<string, number>>;
    readonly peerIds: readonly string[];
    readonly attentionResults: readonly RallarRealtimeSendResult[];
}

export interface PreparedWsSend {
    readonly request: RallarWsSendInput<SendPayload>;
    readonly scope: BlackBoxRallarWsSendDiagnostics['scope'];
    readonly scopeDiagnostics: BlackBoxRallarScopeDiagnostics;
}

export interface WsSendContext
    extends Omit<MessageRoutingDiagnostics, 'minSnapshotVersion'>, Omit<BlackBoxRallarScopeDiagnostics, 'roomRef'> {
    readonly connection: string;
    readonly actor: string | undefined;
    readonly transport: 'ws';
}

type SendPayload = BlackBoxRallarSendInput['payload'];

const DEFAULT_WS_TYPE_ID = 'rallar.black-box.ws.json';

export function toRtcSendRequest(
    input: BlackBoxRallarSendInput,
    config: BlackBoxRallarConnectionConfig
): RallarRtcSendInput<SendPayload> {
    const defaults = config.rallar;
    return {
        typeId: input.typeId ?? resolveBlackBoxRallarTypeId(config),
        topicId: input.topicId ?? resolveBlackBoxRallarTopicId(config),
        roomId: input.roomId ?? config.roomId,
        roomRef: blackBoxRallarRoomRefOf(config, input),
        contextId: input.contextId ?? defaults.contextId,
        resourceId: input.resourceId ?? defaults.resourceId,
        minSnapshotVersion: input.minSnapshotVersion ?? defaults.minSnapshotVersion,
        nextHopPeerIds: input.nextHopPeerIds ?? input.peerIds ?? defaults.nextHopPeerIds ?? defaults.peerIds,
        payload: 'payload' in input ? input.payload : input.data,
        ttlHops: input.ttlHops ?? defaults.ttlHops,
        ttlMs: input.ttlMs ?? defaults.ttlMs,
        reliability: input.reliability ?? defaults.reliability,
        ack: input.ack ?? defaults.ack,
        ownership: input.ownership ?? defaults.ownership,
        membershipEpoch: input.membershipEpoch ?? defaults.membershipEpoch,
        seq: input.seq ?? defaults.seq,
        orderingKey: input.orderingKey ?? defaults.orderingKey,
        overlayId: input.overlayId ?? defaults.overlayId,
        fanoutLimit: input.fanoutLimit ?? defaults.fanoutLimit
    };
}

export function toWsSendRequest(
    input: Parameters<BlackBoxRallarRuntime['sendWs']>[0],
    config: BlackBoxRallarConnectionConfig
): PreparedWsSend {
    const normalized = decodeBlackBoxRallarWsSendInput(input);
    const roomId = normalized.roomId ?? normalized.groupId ?? config.roomId;
    const scope = normalized.scope ?? (roomId ? 'room' : 'all');
    const scopedInput: BlackBoxRallarSendInput = { ...normalized, scope: undefined, roomId };
    const typeId = normalized.typeId ?? normalized.topic ?? normalized.kind ?? DEFAULT_WS_TYPE_ID;
    const defaults = config.rallar;
    const request: RallarWsSendInput<SendPayload> = {
        typeId,
        topicId: normalized.topicId ?? normalized.topic ?? typeId,
        contextId: normalized.contextId ?? roomId ?? scope,
        resourceId: normalized.resourceId,
        scope,
        roomId,
        roomRef: roomId ? blackBoxRallarRoomRefOf(config, scopedInput) : undefined,
        payload: 'payload' in normalized ? normalized.payload : 'data' in normalized ? normalized.data : input,
        minSnapshotVersion: normalized.minSnapshotVersion ?? defaults.minSnapshotVersion,
        exceptPeerIds: normalized.exceptPeerIds,
        ttlHops: normalized.ttlHops ?? defaults.ttlHops,
        ttlMs: normalized.ttlMs ?? defaults.ttlMs,
        reliability: normalized.reliability ?? defaults.reliability,
        ack: normalized.ack ?? defaults.ack,
        ownership: normalized.ownership ?? defaults.ownership
    };
    return { request, scope, scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf(config, scopedInput) };
}

export function toWsSendContext(config: BlackBoxRallarConnectionConfig, prepared: PreparedWsSend): WsSendContext {
    return {
        connection: config.connection,
        actor: config.actor,
        transport: 'ws',
        roomId: prepared.request.roomId,
        roomRef: prepared.request.roomRef,
        typeId: prepared.request.typeId,
        topicId: prepared.request.topicId,
        contextId: prepared.request.contextId,
        resourceId: prepared.request.resourceId,
        ...prepared.scopeDiagnostics
    };
}

/** Undefined when neither the send nor the connection names a peer, so the lane falls back to its ready peers. */
export function resolveRealtimePeerIds(
    input: BlackBoxRallarSendInput,
    config: BlackBoxRallarConnectionConfig
): readonly string[] | undefined {
    if (input.peerIds) {
        return input.peerIds;
    }
    if (input.remotePeerId) {
        return [input.remotePeerId];
    }
    return config.remotePeerId ? [config.remotePeerId] : config.rallar.peerIds;
}

export function toMessageRoutingDiagnostics(
    request: RallarRtcSendInput<SendPayload> | RallarWsSendInput<SendPayload>
): MessageRoutingDiagnostics {
    return {
        roomId: request.roomId,
        roomRef: request.roomRef,
        typeId: request.typeId,
        topicId: request.topicId,
        contextId: request.contextId,
        resourceId: request.resourceId,
        minSnapshotVersion: request.minSnapshotVersion
    };
}

export function computeRealtimeSendSummary(results: readonly RallarRealtimeSendResult[]): RealtimeSendSummary {
    const statuses: Record<string, number> = {};
    for (const entry of results) {
        statuses[entry.result.status] = (statuses[entry.result.status] ?? 0) + 1;
    }
    return {
        total: results.length,
        statuses,
        peerIds: results.map((entry) => entry.peerId),
        attentionResults: results.filter((entry) => entry.result.status !== 'sent')
    };
}

export function toTypedSendOptions(send: BlackBoxRallarMessageSendInput): RallarTypedMessageSendOptions<SendPayload> {
    return {
        strategy: send.carrier,
        ...(send.reliability === undefined ? {} : { reliability: send.reliability }),
        ...(send.ack === undefined ? {} : { ack: send.ack }),
        ...(send.ttlMs === undefined ? {} : { ttlMs: send.ttlMs }),
        ...(send.orderingKey === undefined ? {} : { orderingKey: send.orderingKey }),
        ...(send.seq === undefined ? {} : { seq: send.seq }),
        ...(send.scope === undefined ? {} : { scope: send.scope })
    };
}
