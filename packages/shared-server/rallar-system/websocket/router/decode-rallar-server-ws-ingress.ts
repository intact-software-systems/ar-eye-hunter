import {
    isRoomScopedALMessage,
    readALTargetGroupRef,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeJsonWireValue, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type {
    RallarServerWsRoomAudience,
    RallarServerWsRoomAuthorizationDecision,
    RallarServerWsRoomAuthorizer,
    RallarServerWsTopicDefinition,
    RallarServerWsTopicMetadata
} from './rallar-server-ws-router-contracts.ts';

export type RallarServerWsIngressDecodeResult =
    | Readonly<{ kind: 'decoded'; value: JsonWireValue; }>
    | Readonly<{ kind: 'invalid-json'; }>;

export interface AuthorizeRallarServerWsIngressInput {
    readonly message: ALMessage;
    readonly definition?: RallarServerWsTopicDefinition<JsonWireValue>;
    readonly authorizeRoomMessage?: RallarServerWsRoomAuthorizer;
}

export type RallarServerWsAuthorizationResult =
    | {
        readonly authorized: true;
        readonly audience: RallarServerWsRoomAudience | undefined;
    }
    | {
        readonly authorized: false;
        readonly reason: ALNackReason;
        readonly logMessage: string;
        readonly serverSnapshotVersion: number | undefined;
    };

export function decodeRallarServerWsIngress(
    message: ALMessage
): RallarServerWsIngressDecodeResult {
    try {
        const value = decodeJsonWireValue(
            JSON.parse(message.payload.resource),
            'Rallar server WS payload'
        );
        return { kind: 'decoded', value };
    }
    catch {
        return { kind: 'invalid-json' };
    }
}

export async function authorizeRallarServerWsIngress(
    input: AuthorizeRallarServerWsIngressInput
): Promise<RallarServerWsAuthorizationResult> {
    if (input.definition?.scope !== 'room' && !isRoomScopedALMessage(input.message)) {
        return { authorized: true, audience: undefined };
    }
    const roomId = readRallarServerWsRoomId(input.message);
    if (!roomId || !input.authorizeRoomMessage) {
        return {
            authorized: false,
            reason: 'unauthorized',
            logMessage: `Rejected unauthorised Rallar server WS topic: ${input.message.route.topicId}`,
            serverSnapshotVersion: undefined
        };
    }
    return normalizeRoomAuthorizationDecision(
        await input.authorizeRoomMessage({
            message: input.message,
            definition: input.definition
                ? toRallarServerWsTopicMetadata(input.definition)
                : undefined,
            roomId,
            roomRef: readRallarServerWsRoomRef(input.message),
            senderId: input.message.id.senderId,
            topicId: input.message.route.topicId,
            typeId: input.message.payload.typeId,
            minSnapshotVersion: readRallarServerWsMinSnapshotVersion(input.message)
        }),
        input.message
    );
}

export function toRallarServerWsTopicMetadata(
    definition: RallarServerWsTopicDefinition<JsonWireValue>
): RallarServerWsTopicMetadata {
    return {
        topicId: definition.topicId,
        typeId: definition.typeId,
        scope: definition.scope,
        maxPayloadBytes: definition.maxPayloadBytes,
        fanout: definition.fanout
    };
}

export function readRallarServerWsRoomId(message: ALMessage): string | undefined {
    const groupRef = readALTargetGroupRef(message);
    if (groupRef) {
        return groupRef.groupId;
    }
    if (message.targets?.mode === 'broadcast' && message.targets.scope === 'room') {
        return message.route.contextId;
    }
    return message.route.topicId.startsWith('room.')
        ? message.route.contextId
        : undefined;
}

export function readRallarServerWsRoomRef(message: ALMessage): GroupRef | undefined {
    return readRallarServerWsRoomId(message)
        ? readALTargetGroupRef(message)
        : undefined;
}

function readRallarServerWsMinSnapshotVersion(message: ALMessage): number | undefined {
    const targets = message.targets;
    return targets?.mode === 'multicast' || targets?.mode === 'broadcast'
        ? targets.minSnapshotVersion
        : undefined;
}

function normalizeRoomAuthorizationDecision(
    decision: RallarServerWsRoomAuthorizationDecision,
    message: ALMessage
): RallarServerWsAuthorizationResult {
    if (decision === true) {
        return { authorized: true, audience: undefined };
    }
    if (decision !== false && decision.authorized) {
        return { authorized: true, audience: decision.audience };
    }
    const denial = decision === false ? undefined : decision;
    return {
        authorized: false,
        reason: denial?.reason ?? 'unauthorized',
        logMessage: denial?.logMessage ??
            `Rejected unauthorised Rallar server WS topic: ${message.route.topicId}`,
        serverSnapshotVersion: denial?.serverSnapshotVersion
    };
}
