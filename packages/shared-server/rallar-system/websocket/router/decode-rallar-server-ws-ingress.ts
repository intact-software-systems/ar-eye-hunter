import {
    isRoomScopedALMessage,
    readALTargetGroupRef,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { isALControlTypeId } from '@shared/al-contracts/al-control-type-ids.ts';
import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { RALLAR_AL_CONTROL_TOPIC_ID } from '@shared/api/rallar-validation.ts';
import { decodeJsonWireValue, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { decodeStateSyncMessage } from '../../state-sync/state-sync-payload.ts';
import type {
    RallarServerWsMessage,
    RallarServerWsPayload,
    RallarServerWsRoomAudience,
    RallarServerWsRoomAuthorizationDecision,
    RallarServerWsRoomAuthorizationInput,
    RallarServerWsRoomAuthorizer,
    RallarServerWsTopicAccess,
    RallarServerWsTopicDefinition,
    RallarServerWsTopicMetadata
} from './rallar-server-ws-router-contracts.ts';
import { toRallarServerWsTopicAccess } from './rallar-server-ws-topic-registry.ts';

const RESERVED_TOPIC_IDS = new Set<string>(Object.values(AppTopics));

export function isMiddlewareOwnedMessage(message: ALMessage): boolean {
    return decodeStateSyncMessage(message).kind !== 'unsupported' ||
        RESERVED_TOPIC_IDS.has(message.route.topicId) ||
        message.route.topicId === RALLAR_AL_CONTROL_TOPIC_ID ||
        isALControlTypeId(message.payload.typeId);
}

export type RallarServerWsIngressDecodeResult =
    | Readonly<{ kind: 'decoded'; value: JsonWireValue; }>
    | Readonly<{ kind: 'invalid-json'; }>;

export interface AuthorizeRallarServerWsIngressInput {
    readonly message: ALMessage;
    readonly definition: RallarServerWsTopicDefinition<JsonWireValue> | undefined;
    readonly topic: RallarServerWsTopicAccess;
    /** The session whose publication this is: the sender, or the original sender of a proxy rule's result (D497). */
    readonly senderId: string;
    readonly authorizeRoomMessage: RallarServerWsRoomAuthorizer | undefined;
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

/** Preserve the retained admission deadline through handlers and final publication. */
export function computeAdmittedRallarServerWsMessage(message: ALMessage, expiresAtMs: number): ALMessage {
    return {
        ...message,
        constraints: {
            ...message.constraints,
            expiresAtMs: Math.min(message.constraints?.expiresAtMs ?? expiresAtMs, expiresAtMs)
        }
    };
}

export function toRallarServerWsMessage<T extends RallarServerWsPayload>(
    payload: T,
    raw: ALMessage,
    receivedAtEpochMs: number
): RallarServerWsMessage<T> {
    return { payload, raw, receivedAtEpochMs };
}

export function computeRallarServerWsRetainedAudience(
    audience: RallarServerWsRoomAudience | undefined,
    groupRecipientPeerIds: readonly string[] | undefined
): RallarServerWsRoomAudience | undefined {
    if (!audience || !groupRecipientPeerIds) {
        return audience;
    }
    return {
        ...audience,
        sessions: audience.sessions.filter((session) => groupRecipientPeerIds.includes(session.sessionId))
    };
}

export async function authorizeRallarServerWsIngress(
    input: AuthorizeRallarServerWsIngressInput
): Promise<RallarServerWsAuthorizationResult> {
    if (input.message.proof !== undefined && readALTargetGroupRef(input.message) === undefined) {
        return {
            authorized: false,
            reason: 'unauthorized',
            logMessage: 'A sender publication proof requires a room GroupRef.',
            serverSnapshotVersion: undefined
        };
    }
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
    if (input.message.targets?.mode === 'unicast' && input.message.route.contextId !== roomId) {
        return {
            authorized: false,
            reason: 'unauthorized',
            logMessage: `Rejected room unicast for ${roomId}: its route names room ${input.message.route.contextId}.`,
            serverSnapshotVersion: undefined
        };
    }
    return normalizeRoomAuthorizationDecision(
        await input.authorizeRoomMessage({
            message: input.message,
            definition: input.definition
                ? toRallarServerWsTopicMetadata(input.definition)
                : undefined,
            topic: input.topic,
            roomId,
            roomRef: readRallarServerWsRoomRef(input.message),
            senderId: input.senderId,
            topicId: input.message.route.topicId,
            typeId: input.message.payload.typeId,
            ...toRallarServerWsRoomFloors(input.message)
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
        fanout: definition.fanout,
        ...toRallarServerWsTopicAccess(definition)
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

function toRallarServerWsRoomFloors(
    message: ALMessage
): Pick<RallarServerWsRoomAuthorizationInput, 'minSnapshotVersion' | 'rosterVersion'> {
    const targets = message.targets;
    return targets?.mode === 'multicast' || targets?.mode === 'broadcast'
        ? { minSnapshotVersion: targets.minSnapshotVersion, rosterVersion: targets.rosterVersion }
        : {};
}

function normalizeRoomAuthorizationDecision(
    decision: RallarServerWsRoomAuthorizationDecision,
    message: ALMessage
): RallarServerWsAuthorizationResult {
    if (decision === true || (decision !== false && decision.authorized)) {
        if (message.proof !== undefined && (decision === true || decision.verifiedPublication !== message)) {
            return {
                authorized: false,
                reason: 'unauthorized',
                logMessage: 'Room authorization did not verify the signed publication.',
                serverSnapshotVersion: undefined
            };
        }
        return { authorized: true, audience: decision === true ? undefined : decision.audience };
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
