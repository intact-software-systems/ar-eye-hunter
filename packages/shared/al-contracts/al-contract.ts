import type { ClientPrincipalRef } from '../api/client-types.ts';
import type { GroupRef } from '../api/group-types.ts';
import type { ALQosPolicyRequest } from './al-policy.ts';

// -------------------------------------------------------
// 1) Message identity
// -------------------------------------------------------

/** The one envelope version this build stamps and accepts; a decoder refuses any other as `unsupported`. */
export const AL_MESSAGE_ENVELOPE_VERSION = 3 as const;

export type ALMessageId = Readonly<{
    v: typeof AL_MESSAGE_ENVELOPE_VERSION;
    msgId: string; // UUID for dedup/idempotency
    ts: number; // sender timestamp (epoch ms)
    senderId: string; // stable sender identity (clientId / principalId / nodeId)
    sessionId?: string; // reconnect/session tracing
    traceId?: string; // end-to-end tracing
}>;

// -------------------------------------------------------
// 2) Routing / application classification
// -------------------------------------------------------

export type ALRoute = Readonly<{
    topicId: string; // subscription/routing domain
    resourceId: string; // optional domain entity id
    contextId: string; // room/client/world/application scope
}>;

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
        principalRef?: ClientPrincipalRef; // scope 'principal': own + co-group live sessions only
        exceptPeerIds?: readonly string[];
        minSnapshotVersion?: number;
        /** The sender's cached room roster; absent when it held no room snapshot, and a receiver applies no roster floor. */
        rosterVersion?: number;
        /** Immutable logical audience captured by authoritative server work. */
        recipientPeerIds?: readonly string[];
    }>;

// -------------------------------------------------------
// 4) Forwarding hints for overlay routing
// -------------------------------------------------------

export type ALForwarding = Readonly<{
    nextHopPeerIds?: readonly string[]; // immediate next hops, not final logical recipients
    overlayId?: string; // optional overlay/topology identifier
    fanoutLimit?: number; // optional forwarding fanout hint
}>;

// -------------------------------------------------------
// 5) Constraints
// -------------------------------------------------------

export type ALConstraints = Readonly<{
    ttlHops?: number; // remaining hops; decremented by forwarders
    expiresAtMs?: number; // wall-clock expiry; drop if now > expiresAtMs
}>;

// -------------------------------------------------------
// 6) Ordering
// -------------------------------------------------------

export type ALOrdering = Readonly<{
    orderingKey?: string; // e.g. groupId or senderId or roomId
    epoch?: number; // ordering track epoch
    seq?: number; // monotonic within orderingKey + sender or server ordering
}>;

// -------------------------------------------------------
// 7) Delivery semantics
// -------------------------------------------------------

export type ALAckMode = 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader';

export type ALDelivery = Readonly<{
    ownership?: 'shared' | 'exclusive'; // pubsub vs queue-like semantics
    reliability: 'best-effort' | 'at-least-once'; // avoid vague "reliable"
    ack: ALAckMode;
}>;

// -------------------------------------------------------
// 8) Actions / correlation
// -------------------------------------------------------

export type ALActions = Readonly<{
    corrId?: string; // correlation id for request/reply
    replyToMsgId?: string; // message id this replies to
}>;

// -------------------------------------------------------
// 9) Payload
// -------------------------------------------------------

export type ALPayload = Readonly<{
    typeId: string; // schema/message type used for TS mapping/decoding
    contentType?: 'application/json';
    resource: string; // JSON string; keeps wire format explicit
}>;

// -------------------------------------------------------
// 10) Optional diagnostics
// -------------------------------------------------------

export type ALDiagnostics = Readonly<{
    visitedPeerIds?: readonly string[]; // optional, bounded; mainly diagnostic
}>;

// -------------------------------------------------------
// 11) Optional provenance
// -------------------------------------------------------

export type ALAudit = Readonly<{
    createdBy?: string;
    createdTs?: number;
}>;

// -------------------------------------------------------
// 12) The wire message
// -------------------------------------------------------

export type ALMessage = Readonly<{
    id: ALMessageId;
    route: ALRoute;

    targets?: ALTargets;
    forwarding?: ALForwarding;
    constraints?: ALConstraints;
    ordering?: ALOrdering;

    delivery?: ALDelivery;
    actions?: ALActions;
    qos?: ALQosPolicyRequest;

    payload: ALPayload;

    audit?: ALAudit;
    diagnostics?: ALDiagnostics;
}>;

// -------------------------------------------------------
// 13) Builders
// -------------------------------------------------------

type ALMessageBuilderOptions = Readonly<{
    qos?: ALQosPolicyRequest;
    ttlMs?: number;
}>;

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
            senderId: senderId
        },
        route,
        constraints: expiresAtMs !== undefined
            ? { expiresAtMs }
            : undefined,
        qos: options?.qos,
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
            : { mode: 'unicast', toPeerId, groupRef: toALGroupRef(options.groupRef) },
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
    }>
): ALMessage {
    const untargeted = newALUntargetedMessage(senderId, route, typeId, resource, {
        qos: options?.qos,
        ttlMs: options?.ttlMs
    });
    const expiresAtMs = untargeted.constraints?.expiresAtMs;
    const targetGroupRef = toALGroupRef(groupRef);

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

function toALGroupRef(ref: GroupRef): GroupRef {
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId
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
 * topic, a multicast, a unicast that names its room, or a room-scoped broadcast. Room-scoped delivery is
 * owned by the topic router behind its room authorizer; transports must not
 * relay these on their own, or the authorization is bypassed.
 */
export function isRoomScopedALMessage(message: ALMessage): boolean {
    return message.route.topicId.startsWith('room.') ||
        message.targets?.mode === 'multicast' ||
        (message.targets?.mode === 'unicast' && message.targets.groupRef !== undefined) ||
        (message.targets?.mode === 'broadcast' &&
            message.targets.scope === 'room');
}

export function readALTargetGroupRef(message: ALMessage): GroupRef | undefined {
    const targets = message.targets;
    if (targets?.mode === 'unicast') {
        return targets.groupRef === undefined ? undefined : toALGroupRef(targets.groupRef);
    }
    if (targets?.mode === 'multicast') {
        return toALGroupRef(targets.groupRef);
    }

    if (
        targets?.mode === 'broadcast' &&
        targets.scope === 'room' &&
        targets.groupRef !== undefined
    ) {
        return toALGroupRef(targets.groupRef);
    }

    return undefined;
}

export function newALBroadcastMessage<T>(
    senderId: string,
    route: ALRoute,
    scope: 'room' | 'world' | 'all',
    typeId: string,
    resource: T,
    options?: Readonly<{
        groupRef?: GroupRef;
        exceptPeerIds?: readonly string[];
        minSnapshotVersion?: number;
        rosterVersion?: number;
        ttlHops?: number;
        ttlMs?: number;
        reliability?: 'best-effort' | 'at-least-once';
        ack?: ALAckMode;
        ownership?: 'shared' | 'exclusive';
        qos?: ALQosPolicyRequest;
        /** A sequence left out is minted by the WS server's outbound for its own publication. */
        ordering?: Readonly<{ orderingKey: string; epoch?: number; seq?: number; }>;
    }>
): ALMessage {
    const groupRef = scope === 'room' && options?.groupRef !== undefined
        ? toALGroupRef(options.groupRef)
        : undefined;
    const untargeted = newALUntargetedMessage(senderId, route, typeId, resource, {
        qos: options?.qos,
        ttlMs: options?.ttlMs
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
            rosterVersion: options?.rosterVersion
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
