import type { RallarCrdtDocumentRef } from '../crdt/mod.ts';
import type { Key } from '../queuebox/ResourceEntry.ts';
import type { GroupRef, PrincipalId, SessionId } from './group-types.ts';
import type { StateScope } from './state-types.ts';

export const ADMIN_SUPPORT_EXPLAIN_ENDPOINTS = [
    '/api/admin/support/explain/client',
    '/api/admin/support/explain/group',
    '/api/admin/support/explain/request',
    '/api/admin/support/explain/crdt-document',
    '/api/admin/support/explain/queue-item'
] as const;

export const ADMIN_SUPPORT_FACT_CERTAINTIES = [
    'exact',
    'inferred',
    'unavailable'
] as const;

export const ADMIN_SUPPORT_SUGGESTED_ACTION_SEVERITIES = [
    'info',
    'warning',
    'urgent'
] as const;

export type AdminSupportExplainEndpoint = typeof ADMIN_SUPPORT_EXPLAIN_ENDPOINTS[number];

export type AdminSupportFactCertainty = typeof ADMIN_SUPPORT_FACT_CERTAINTIES[number];

export type AdminSupportSuggestedActionSeverity = typeof ADMIN_SUPPORT_SUGGESTED_ACTION_SEVERITIES[number];

export type AdminSupportWarning = Readonly<{
    code: string;
    message: string;
    source?: string;
}>;

export type AdminSupportFact = Readonly<{
    label: string;
    source: string;
    value: unknown;
    certainty: AdminSupportFactCertainty;
    redacted?: boolean;
}>;

export type AdminSupportTimelineItem = Readonly<{
    atEpochMs?: number;
    source: string;
    eventType: string;
    summary: string;
    rawRef?: string;
}>;

export type AdminSupportSuggestedAction = Readonly<{
    code: string;
    label: string;
    severity: AdminSupportSuggestedActionSeverity;
    operationRef?: string;
}>;

export type AdminSupportClientTarget = Readonly<{
    kind: 'client';
    scope: StateScope;
    principalId: PrincipalId;
    clientInstanceId?: string;
    sessionId?: SessionId;
}>;

export type AdminSupportGroupTarget = Readonly<{
    kind: 'group';
    groupRef: GroupRef;
    principalId?: PrincipalId;
    sessionId?: SessionId;
}>;

export type AdminSupportRequestTarget = Readonly<{
    kind: 'request';
    requestId?: string;
    idempotencyKey?: string;
    queueKey?: Key;
    target?: unknown;
}>;

export type AdminSupportCrdtDocumentTarget = Readonly<{
    kind: 'crdt-document';
    document: RallarCrdtDocumentRef;
}>;

export type AdminSupportQueueItemTarget = Readonly<{
    kind: 'queue-item';
    queueKey: Key;
}>;

export type AdminSupportTarget =
    | AdminSupportClientTarget
    | AdminSupportGroupTarget
    | AdminSupportRequestTarget
    | AdminSupportCrdtDocumentTarget
    | AdminSupportQueueItemTarget;

export type AdminSupportNarrativeResponse = Readonly<{
    target: AdminSupportTarget;
    generatedAtEpochMs: number;
    serverId?: string;
    facts: readonly AdminSupportFact[];
    timeline: readonly AdminSupportTimelineItem[];
    warnings: readonly AdminSupportWarning[];
    likelyCauses: readonly string[];
    suggestedActions: readonly AdminSupportSuggestedAction[];
    rawRefs: readonly string[];
}>;

export type AdminSupportExplainClientRequest = Readonly<{
    scope: StateScope;
    principalId: PrincipalId;
    clientInstanceId?: string;
    sessionId?: SessionId;
    limitRecentEvents?: number;
}>;

export type AdminSupportExplainGroupRequest = Readonly<{
    groupRef: GroupRef;
    principalId?: PrincipalId;
    sessionId?: SessionId;
    limitRecentEvents?: number;
}>;

export type AdminSupportExplainRequestRequest = Readonly<{
    requestId?: string;
    idempotencyKey?: string;
    queueKey?: Key;
    target?: unknown;
}>;

export type AdminSupportExplainCrdtDocumentRequest = Readonly<{
    document: RallarCrdtDocumentRef;
    includeIntegrity?: boolean;
    includeRedactedDebugBundle?: boolean;
}>;

export type AdminSupportExplainQueueItemRequest = Readonly<{
    queueKey: Key;
    includeExpired?: boolean;
}>;
