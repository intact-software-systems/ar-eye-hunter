import type { ClientPrincipalRef } from '../api/client-types.ts';
import { toCanonicalGroupRef, type GroupRef } from '../api/group-types.ts';
import type { ALQosPolicyRequest } from './al-policy.ts';
import type { ALPublicationProof } from './publication-proof/al-publication-proof.ts';
import { toALPrincipalBroadcastTargets } from './read-al-principal-broadcast-target.ts';
import { newALTraceId } from './trace/al-trace-id.ts';

// -------------------------------------------------------
// 1) Message identity
// -------------------------------------------------------

/** The one envelope version this build stamps and accepts; a decoder refuses any other as `unsupported`. */
export const AL_MESSAGE_ENVELOPE_VERSION = 4 as const;

export interface ALMessageId {
    readonly v: typeof AL_MESSAGE_ENVELOPE_VERSION;
    readonly msgId: string; // UUID for dedup/idempotency
    readonly ts: number; // sender timestamp (epoch ms)
    readonly senderId: string; // stable sender identity (clientId / principalId / nodeId)
    readonly sessionId?: string; // reconnect/session tracing
    readonly traceId: string;
}

// -------------------------------------------------------
// 2) Routing / application classification
// -------------------------------------------------------

export interface ALRoute {
    readonly topicId: string; // subscription/routing domain
    readonly resourceId: string; // optional domain entity id
    readonly contextId: string; // room/client/world/application scope
}

// -------------------------------------------------------
// 3) Logical destination
// -------------------------------------------------------

export type ALTargets =
    | Readonly<{
        mode: 'unicast';
        toPeerId: string;
        /** The room the unicast is addressed in: its room's authority admits it and the room's router delivers it (D53). */
        groupRef?: GroupRef;
    }>
    | Readonly<{
        mode: 'multicast';
        groupRef: GroupRef;
        minSnapshotVersion?: number;
        /** The sender's cached room roster; absent when it held no room snapshot, and a receiver applies no roster floor. */
        rosterVersion?: number;
        /**
         * The logical audience the origin froze at admission, with the room snapshot version it was read
         * at; both or neither. Absent means not yet frozen: the carrier that admits the message freezes it.
         */
        recipientPeerIds?: readonly string[];
        snapshotVersion?: number;
    }>
    | Readonly<{
        mode: 'broadcast';
        scope: 'room' | 'world' | 'all' | 'principal';
        groupRef?: GroupRef;
        /** Scope 'principal': the principal's live sessions in the room `groupRef` names. */
        principalRef?: ClientPrincipalRef;
        exceptPeerIds?: readonly string[];
        minSnapshotVersion?: number;
        /** The sender's cached room roster; absent when it held no room snapshot, and a receiver applies no roster floor. */
        rosterVersion?: number;
        /**
         * The sender's fixed audience inside the room, or the audience a server captured for replayable work;
         * never wider than the room.
         */
        recipientPeerIds?: readonly string[];
    }>;

// -------------------------------------------------------
// 4) Forwarding hints for overlay routing
// -------------------------------------------------------

export interface ALForwarding {
    readonly nextHopPeerIds?: readonly string[]; // immediate next hops, not final logical recipients
    readonly overlayId?: string; // optional overlay/topology identifier
    readonly fanoutLimit?: number; // optional forwarding fanout hint
}

// -------------------------------------------------------
// 5) Constraints
// -------------------------------------------------------

export interface ALConstraints {
    readonly ttlHops?: number; // remaining hops; decremented by forwarders
    readonly expiresAtMs?: number; // wall-clock expiry; drop if now > expiresAtMs
}

// -------------------------------------------------------
// 6) Ordering
// -------------------------------------------------------

export interface ALOrdering {
    readonly orderingKey?: string; // e.g. groupId or senderId or roomId
    readonly epoch?: number; // ordering track epoch
    readonly seq?: number; // monotonic within orderingKey + sender or server ordering
}

// -------------------------------------------------------
// 7) Delivery semantics
// -------------------------------------------------------

export type ALAckMode = 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader';

export interface ALDelivery {
    readonly ownership?: 'shared' | 'exclusive'; // pubsub vs queue-like semantics
    readonly reliability: 'best-effort' | 'at-least-once'; // avoid vague "reliable"
    readonly ack: ALAckMode;
}

// -------------------------------------------------------
// 8) Actions / correlation
// -------------------------------------------------------

export interface ALActions {
    readonly corrId?: string; // correlation id for request/reply
    readonly replyToMsgId?: string; // message id this replies to
}

// -------------------------------------------------------
// 9) Payload
// -------------------------------------------------------

export interface ALPayload {
    readonly typeId: string; // schema/message type used for TS mapping/decoding
    readonly contentType?: 'application/json';
    readonly resource: string; // JSON string; keeps wire format explicit
}

// -------------------------------------------------------
// 10) Optional diagnostics
// -------------------------------------------------------

export interface ALDiagnostics {
    readonly visitedPeerIds?: readonly string[]; // optional, bounded; mainly diagnostic
}

// -------------------------------------------------------
// 11) Optional provenance
// -------------------------------------------------------

export interface ALAudit {
    readonly createdBy?: string;
    readonly createdTs?: number;
}

// -------------------------------------------------------
// 12) The wire message
// -------------------------------------------------------

export interface ALMessage {
    readonly id: ALMessageId;
    readonly route: ALRoute;

    readonly targets?: ALTargets;
    readonly forwarding?: ALForwarding;
    readonly constraints?: ALConstraints;
    readonly ordering?: ALOrdering;

    readonly delivery?: ALDelivery;
    readonly actions?: ALActions;
    readonly qos?: ALQosPolicyRequest;

    readonly payload: ALPayload;

    readonly audit?: ALAudit;
    readonly diagnostics?: ALDiagnostics;
    /** The publisher's signature over the signed fields; absent on a members frame, which no grant restricts. */
    readonly proof?: ALPublicationProof;
}

// -------------------------------------------------------
// 13) Builders
// -------------------------------------------------------

interface ALMessageBuilderOptions {
    readonly qos?: ALQosPolicyRequest;
    readonly ttlMs?: number;
    readonly actions?: ALActions;
    readonly traceId?: string;
}

export interface ALBroadcastMessageBuilderOptions {
    readonly exceptPeerIds?: readonly string[];
    readonly minSnapshotVersion?: number;
    readonly rosterVersion?: number;
    readonly ttlHops?: number;
    readonly ttlMs?: number;
    readonly reliability?: 'best-effort' | 'at-least-once';
    readonly ack?: ALAckMode;
    readonly ownership?: 'shared' | 'exclusive';
    readonly qos?: ALQosPolicyRequest;
    readonly actions?: ALActions;
    readonly traceId?: string;
    /** A sequence left out is minted by the WS server's outbound for its own publication. */
    readonly ordering?: Readonly<{ orderingKey: string; epoch?: number; seq?: number; }>;
}

type ALUnicastMessageBuilderOptions =
    & ALMessageBuilderOptions
    & Readonly<{
        groupRef?: GroupRef;
        reliability?: 'best-effort' | 'at-least-once';
        ack?: ALAckMode;
        ownership?: 'shared' | 'exclusive';
    }>;

export function newALRoute(
    topicId: string,
    contextId: string,
    resourceId: string
): ALRoute {
    return {
        topicId,
        resourceId,
        contextId
    };
}

export function newALEventRoute(
    topicId: string,
    contextId: string,
    resourceId: string = crypto.randomUUID()
): ALRoute {
    return newALRoute(topicId, contextId, resourceId);
}

function buildALMessage<T>(
    senderId: string,
    route: ALRoute,
    typeId: string,
    resource: T,
    options?: ALMessageBuilderOptions,
    msgId: string = crypto.randomUUID()
): ALMessage {
    const now = Date.now();
    const expiresAtMs = options?.ttlMs !== undefined
        ? now + options.ttlMs
        : undefined;

    return {
        id: {
            v: AL_MESSAGE_ENVELOPE_VERSION,
            msgId,
            ts: now,
            senderId: senderId,
            traceId: options?.traceId ?? newALTraceId()
        },
        route,
        constraints: expiresAtMs !== undefined
            ? { expiresAtMs }
            : undefined,
        qos: options?.qos,
        ...(options?.actions === undefined ? {} : { actions: options.actions }),
        payload: {
            typeId: typeId,
            contentType: 'application/json',
            resource: JSON.stringify(resource)
        },
        audit: {
            createdBy: senderId,
            createdTs: now
        }
    };
}

export function newALUntargetedMessage<T>(
    senderId: string,
    route: ALRoute,
    typeId: string,
    resource: T,
    options?: ALMessageBuilderOptions
): ALMessage {
    return buildALMessage(senderId, route, typeId, resource, options);
}

export function newALUnicastMessage<T>(
    senderId: string,
    route: ALRoute,
    toPeerId: string,
    typeId: string,
    resource: T,
    options?: ALUnicastMessageBuilderOptions
): ALMessage {
    return {
        ...newALUntargetedMessage(senderId, route, typeId, resource, options),
        targets: options?.groupRef === undefined
            ? { mode: 'unicast', toPeerId }
            : { mode: 'unicast', toPeerId, groupRef: toCanonicalGroupRef(options.groupRef) },
        ...(options?.reliability === undefined && options?.ack === undefined
            ? {}
            : {
                delivery: {
                    ownership: options?.ownership,
                    reliability: options?.reliability ?? 'best-effort',
                    ack: options?.ack ?? 'none'
                }
            })
    };
}

export function newALMulticastMessage<T>(
    senderId: string,
    route: ALRoute,
    groupRef: GroupRef,
    typeId: string,
    resource: T,
    options?: Readonly<{
        minSnapshotVersion?: number;
        rosterVersion?: number;
        ttlHops?: number;
        ttlMs?: number;
        seq?: number;
        orderingKey?: string;
        reliability?: 'best-effort' | 'at-least-once';
        ack?: ALAckMode;
        ownership?: 'shared' | 'exclusive';
        nextHopPeerIds?: readonly string[];
        overlayId?: string;
        fanoutLimit?: number;
        qos?: ALQosPolicyRequest;
        actions?: ALActions;
        traceId?: string;
    }>
): ALMessage {
    const untargeted = newALUntargetedMessage(senderId, route, typeId, resource, {
        qos: options?.qos,
        ttlMs: options?.ttlMs,
        actions: options?.actions,
        traceId: options?.traceId
    });
    const expiresAtMs = untargeted.constraints?.expiresAtMs;
    const targetGroupRef = toCanonicalGroupRef(groupRef);

    return {
        ...untargeted,
        targets: {
            mode: 'multicast',
            groupRef: targetGroupRef,
            minSnapshotVersion: options?.minSnapshotVersion,
            rosterVersion: options?.rosterVersion
        },
        forwarding: options?.nextHopPeerIds !== undefined ||
                options?.overlayId !== undefined ||
                options?.fanoutLimit !== undefined
            ? {
                nextHopPeerIds: options?.nextHopPeerIds,
                overlayId: options?.overlayId,
                fanoutLimit: options?.fanoutLimit
            }
            : undefined,
        constraints: options?.ttlHops !== undefined || expiresAtMs !== undefined
            ? {
                ttlHops: options?.ttlHops,
                expiresAtMs
            }
            : undefined,
        ordering: options?.seq !== undefined || options?.orderingKey !== undefined
            ? {
                orderingKey: options?.orderingKey ?? toALGroupTargetKey(targetGroupRef),
                seq: options?.seq
            }
            : undefined,
        delivery: {
            ownership: options?.ownership,
            reliability: options?.reliability ?? 'best-effort',
            ack: options?.ack ?? 'none'
        }
    };
}

export function toALGroupTargetKey(group: string | GroupRef): string {
    if (typeof group === 'string') {
        return group;
    }

    return JSON.stringify([
        group.applicationId,
        group.workspaceId ?? '',
        group.groupId
    ]);
}

/**
 * Whether a message addresses a room audience by its own shape — a `room.`
 * topic, a multicast, a unicast that names its room, or a room or principal broadcast that names its room. Room-scoped delivery is
 * owned by the topic router behind its room authorizer; transports must not
 * relay these on their own, or the authorization is bypassed.
 */
export function isRoomScopedALMessage(message: ALMessage): boolean {
    const targets = message.targets;
    return message.route.topicId.startsWith('room.') ||
        targets?.mode === 'multicast' ||
        (targets?.mode === 'unicast' && targets.groupRef !== undefined) ||
        (targets?.mode === 'broadcast' &&
            (targets.scope === 'room' || (targets.scope === 'principal' && targets.groupRef !== undefined)));
}

export function readALTargetGroupRef(message: Pick<ALMessage, 'targets'>): GroupRef | undefined {
    const targets = message.targets;
    if (targets?.mode === 'unicast') {
        return targets.groupRef === undefined ? undefined : toCanonicalGroupRef(targets.groupRef);
    }
    if (targets?.mode === 'multicast') {
        return toCanonicalGroupRef(targets.groupRef);
    }

    if (
        targets?.mode === 'broadcast' &&
        (targets.scope === 'room' || targets.scope === 'principal') &&
        targets.groupRef !== undefined
    ) {
        return toCanonicalGroupRef(targets.groupRef);
    }

    return undefined;
}

export function newALBroadcastMessage<T>(
    senderId: string,
    route: ALRoute,
    scope: 'room' | 'world' | 'all',
    typeId: string,
    resource: T,
    options?:
        & ALBroadcastMessageBuilderOptions
        & Readonly<{
            groupRef?: GroupRef;
            /** Room scope only: the canonical decoder refuses a list with another scope as malformed. */
            recipientPeerIds?: readonly string[];
        }>
): ALMessage {
    const groupRef = scope === 'room' && options?.groupRef !== undefined
        ? toCanonicalGroupRef(options.groupRef)
        : undefined;
    const untargeted = newALUntargetedMessage(senderId, route, typeId, resource, {
        qos: options?.qos,
        ttlMs: options?.ttlMs,
        actions: options?.actions,
        traceId: options?.traceId
    });
    const expiresAtMs = untargeted.constraints?.expiresAtMs;

    return {
        ...untargeted,
        targets: {
            mode: 'broadcast',
            scope,
            groupRef,
            exceptPeerIds: options?.exceptPeerIds,
            minSnapshotVersion: options?.minSnapshotVersion,
            rosterVersion: options?.rosterVersion,
            recipientPeerIds: options?.recipientPeerIds
        },
        constraints: options?.ttlHops !== undefined || expiresAtMs !== undefined
            ? {
                ttlHops: options?.ttlHops,
                expiresAtMs
            }
            : undefined,
        ordering: options?.ordering !== undefined
            ? {
                orderingKey: options.ordering.orderingKey,
                epoch: options.ordering.epoch,
                seq: options.ordering.seq
            }
            : undefined,
        delivery: {
            ownership: options?.ownership,
            reliability: options?.reliability ?? 'best-effort',
            ack: options?.ack ?? 'none'
        }
    };
}

export interface ALPrincipalBroadcastTarget {
    readonly groupRef: GroupRef;
    readonly principalRef: ClientPrincipalRef;
}

/** A broadcast to the principal's live sessions in one room: room-bounded, so both carriers resolve it from the room. */
export function newALPrincipalBroadcastMessage<T>(
    senderId: string,
    route: ALRoute,
    target: ALPrincipalBroadcastTarget,
    typeId: string,
    resource: T,
    options?: ALBroadcastMessageBuilderOptions
): ALMessage {
    const roomBroadcast = newALBroadcastMessage(senderId, route, 'room', typeId, resource, options);
    return { ...roomBroadcast, targets: toALPrincipalBroadcastTargets(target, options) };
}
