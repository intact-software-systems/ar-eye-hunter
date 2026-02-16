// application-layer-contracts.v1.ts

export type ALMessageKey = Readonly<{
    topicId: string;
    resourceId: string;
    contextId: string; // can be used as default routing fallback (e.g., clientId)
}>;

// 2) Delivery/message identity (NEW)
export type ALMessageId = Readonly<{
    v: 1;              // protocol version (number is easiest)
    msgId: string;     // UUID; used for dedup + idempotency
    ts: number;        // sender timestamp (epoch ms)
    sender: string;    // stable sender identity (clientId / principalId / nodeId)
    sessionId: string; // changes on reconnect; helps trace
    traceId?: string;  // optional end-to-end tracing
}>;

// 3) Addressing (unicast/multicast/broadcast unified)
export type ALTargets =
    | Readonly<{ mode: "unicast"; to: string }>
    | Readonly<{ mode: "multicast"; groupId: string; to?: readonly string[] }> // group + optional explicit list
    | Readonly<{ mode: "broadcast"; scope: "room" | "world" | "all"; except?: readonly string[] }>;

// 4) Routing constraints (TTL/expiry)
export type ALConstraints = Readonly<{
    // Choose ONE primary expiry mechanism. You can support both, but be explicit.
    ttlHops?: number;       // remaining hops; decremented by forwarders
    expiresAtMs?: number;   // wall-clock expiry; drop if now > expiresAtMs
}>;

// 5) Ordering (optional but useful for multicast)
export type ALOrdering = Readonly<{
    // If you do hub ordering, server can stamp groupSeq.
    // If you do P2P, use per-sender seq within a group.
    groupId?: string;
    epoch?: number;        // group membership epoch/version
    seq?: number;          // per sender per group (or server assigned)
}>;

// 6) QoS and acks (make semantics explicit)
export type ALAckMode = "none" | "receiver" | "all" | "group-leader";

export type ALMessageQoS = Readonly<{
    ownership: "shared" | "exclusive";            // pubsub vs queue-like semantics
    reliability: "best-effort" | "at-least-once"; // avoid vague "reliable"
    ack: ALAckMode;
    ttlMs?: number; // optional alternative to expiresAtMs (engine can compute expiresAtMs)
}>;

// 7) Actions / correlation (request-reply + acks)
export type ALMessageActions = Readonly<{
    corrId?: string;    // correlation id for request/reply
    replyTo?: string;   // message id this replies to (or corrId-based)
}>;

// 8) Payload
export type ALPayload = Readonly<{
    typeId: string;     // your schema/message type
    contentType?: "application/json";
    resource: string;   // JSON string (keep as string if you want strict wire format)
    // Alternative: payload: unknown (if you prefer structured objects on the wire)
}>;

// 9) Optional forwarding history (keep it bounded)
export type ALMessageHistory = Readonly<{
    visited?: readonly string[]; // optional, bounded
}>;

// 10) The wire message
export type ALRouting = Readonly<{
    id: ALMessageId;
    key: ALMessageKey;

    targets: ALTargets;
    constraints?: ALConstraints;
    ordering?: ALOrdering;

    qos: ALMessageQoS;
    actions?: ALMessageActions;

    payload: ALPayload;

    audit: Readonly<{
        createdBy: string;
        createdTs: number;
    }>;

    history?: ALMessageHistory;
}>;