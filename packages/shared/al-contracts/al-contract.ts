import type { ALQosPolicyRequest } from './al-policy.ts';

// -------------------------------------------------------
// 1) Message identity
// -------------------------------------------------------

export type ALMessageId = Readonly<{
    v: 2;
    msgId: string;       // UUID for dedup/idempotency
    ts: number;          // sender timestamp (epoch ms)
    senderId: string;    // stable sender identity (clientId / principalId / nodeId)
    sessionId?: string;  // reconnect/session tracing
    traceId?: string;    // end-to-end tracing
}>;

// -------------------------------------------------------
// 2) Routing / application classification
// -------------------------------------------------------

export type ALRoute = Readonly<{
    topicId: string;     // subscription/routing domain
    resourceId: string;   // optional domain entity id
    contextId: string;   // room/client/world/application scope
}>;

// -------------------------------------------------------
// 3) Logical destination
// -------------------------------------------------------

export type ALTargets =
    | Readonly<{
    mode: 'unicast';
    toPeerId: string;
}>
    | Readonly<{
    mode: 'multicast';
    groupId: string;
    membershipEpoch?: number;
}>
    | Readonly<{
    mode: 'broadcast';
    scope: 'room' | 'world' | 'all';
    exceptPeerIds?: readonly string[];
}>;

// -------------------------------------------------------
// 4) Forwarding hints for overlay routing
// -------------------------------------------------------

export type ALForwarding = Readonly<{
    nextHopPeerIds?: readonly string[]; // immediate next hops, not final logical recipients
    overlayId?: string;                 // optional overlay/topology identifier
    fanoutLimit?: number;               // optional forwarding fanout hint
}>;

// -------------------------------------------------------
// 5) Constraints
// -------------------------------------------------------

export type ALConstraints = Readonly<{
    ttlHops?: number;     // remaining hops; decremented by forwarders
    expiresAtMs?: number; // wall-clock expiry; drop if now > expiresAtMs
}>;

// -------------------------------------------------------
// 6) Ordering
// -------------------------------------------------------

export type ALOrdering = Readonly<{
    orderingKey?: string; // e.g. groupId or senderId or roomId
    epoch?: number;       // membership/view/order epoch
    seq?: number;         // monotonic within orderingKey + sender or server ordering
}>;

// -------------------------------------------------------
// 7) Delivery semantics
// -------------------------------------------------------

export type ALAckMode = 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader';

export type ALDelivery = Readonly<{
    ownership?: 'shared' | 'exclusive';             // pubsub vs queue-like semantics
    reliability: 'best-effort' | 'at-least-once';   // avoid vague "reliable"
    ack: ALAckMode;
}>;

// -------------------------------------------------------
// 8) Actions / correlation
// -------------------------------------------------------

export type ALActions = Readonly<{
    corrId?: string;      // correlation id for request/reply
    replyToMsgId?: string; // message id this replies to
}>;

// -------------------------------------------------------
// 9) Payload
// -------------------------------------------------------

export type ALPayload = Readonly<{
    typeId: string;                  // schema/message type used for TS mapping/decoding
    contentType?: 'application/json';
    resource: string;                // JSON string; keeps wire format explicit
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
}>;

export function newALRoute(
    topicId: string,
    contextId: string,
    resourceId: string,
): ALRoute {
    return {
        topicId,
        resourceId,
        contextId,
    };
}

export function newALEventRoute(
    topicId: string,
    contextId: string,
    resourceId: string = crypto.randomUUID(),
): ALRoute {
    return newALRoute(topicId, contextId, resourceId);
}

function buildALMessage<T>(
    senderId: string,
    route: ALRoute,
    typeId: string,
    resource: T,
    options?: ALMessageBuilderOptions,
    msgId: string = crypto.randomUUID(),
): ALMessage {
    const now = Date.now();

    return {
        id: {
            v: 2,
            msgId,
            ts: now,
            senderId: senderId,
        },
        route,
        qos: options?.qos,
        payload: {
            typeId: typeId,
            contentType: 'application/json',
            resource: JSON.stringify(resource),
        },
        audit: {
            createdBy: senderId,
            createdTs: now,
        },
    };
}

export function newALUntargetedMessage<T>(
    senderId: string,
    route: ALRoute,
    typeId: string,
    resource: T,
    options?: ALMessageBuilderOptions,
): ALMessage {
    return buildALMessage(senderId, route, typeId, resource, options);
}

export function newALUnicastMessage<T>(
    senderId: string,
    route: ALRoute,
    toPeerId: string,
    typeId: string,
    resource: T,
    options?: ALMessageBuilderOptions,
): ALMessage {
    return {
        ...newALUntargetedMessage(senderId, route, typeId, resource, options),
        targets: {
            mode: 'unicast',
            toPeerId,
        },
    };
}

export function newALMulticastMessage<T>(
    senderId: string,
    route: ALRoute,
    groupId: string,
    typeId: string,
    resource: T,
    options?: Readonly<{
        membershipEpoch?: number;
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
    }>,
): ALMessage {
    const expiresAtMs = options?.ttlMs !== undefined
        ? Date.now() + options.ttlMs
        : undefined;

    return {
        ...newALUntargetedMessage(senderId, route, typeId, resource, { qos: options?.qos }),
        targets: {
            mode: 'multicast',
            groupId,
            membershipEpoch: options?.membershipEpoch,
        },
        forwarding: options?.nextHopPeerIds !== undefined
        || options?.overlayId !== undefined
        || options?.fanoutLimit !== undefined
            ? {
                nextHopPeerIds: options?.nextHopPeerIds,
                overlayId: options?.overlayId,
                fanoutLimit: options?.fanoutLimit,
            }
            : undefined,
        constraints: options?.ttlHops !== undefined || expiresAtMs !== undefined
            ? {
                ttlHops: options?.ttlHops,
                expiresAtMs,
            }
            : undefined,
        ordering: options?.seq !== undefined
        || options?.orderingKey !== undefined
        || options?.membershipEpoch !== undefined
            ? {
                orderingKey: options?.orderingKey ?? groupId,
                epoch: options?.membershipEpoch,
                seq: options?.seq,
            }
            : undefined,
        delivery: {
            ownership: options?.ownership,
            reliability: options?.reliability ?? 'best-effort',
            ack: options?.ack ?? 'none',
        },
    };
}

export function newALBroadcastMessage<T>(
    senderId: string,
    route: ALRoute,
    scope: 'room' | 'world' | 'all',
    typeId: string,
    resource: T,
    options?: Readonly<{
        exceptPeerIds?: readonly string[];
        ttlHops?: number;
        ttlMs?: number;
        reliability?: 'best-effort' | 'at-least-once';
        ack?: ALAckMode;
        ownership?: 'shared' | 'exclusive';
        qos?: ALQosPolicyRequest;
    }>,
): ALMessage {
    const expiresAtMs = options?.ttlMs !== undefined
        ? Date.now() + options.ttlMs
        : undefined;

    return {
        ...newALUntargetedMessage(senderId, route, typeId, resource, { qos: options?.qos }),
        targets: {
            mode: 'broadcast',
            scope,
            exceptPeerIds: options?.exceptPeerIds,
        },
        constraints: options?.ttlHops !== undefined || expiresAtMs !== undefined
            ? {
                ttlHops: options?.ttlHops,
                expiresAtMs,
            }
            : undefined,
        delivery: {
            ownership: options?.ownership,
            reliability: options?.reliability ?? 'best-effort',
            ack: options?.ack ?? 'none',
        },
    };
}
