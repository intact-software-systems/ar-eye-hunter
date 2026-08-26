import type { RallarCrdtDocumentRef } from '../../crdt/mod.ts';
import type { Key } from '../../queuebox/ResourceEntry.ts';
import type { GroupRef, PrincipalId, SessionId } from '../group-types.ts';
import type { StateScope } from '../state-types.ts';

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

export type AdminSupportJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly AdminSupportJsonValue[]
    | AdminSupportJsonObject;

export interface AdminSupportJsonObject {
    readonly [key: string]: AdminSupportJsonValue;
}

export interface AdminSupportWarning {
    readonly code: string;
    readonly message: string;
    readonly source?: string;
}

export interface AdminSupportFact {
    readonly label: string;
    readonly source: string;
    readonly value: AdminSupportJsonValue;
    readonly certainty: AdminSupportFactCertainty;
    readonly redacted?: boolean;
}

export interface AdminSupportTimelineItem {
    readonly atEpochMs?: number;
    readonly source: string;
    readonly eventType: string;
    readonly summary: string;
    readonly rawRef?: string;
}

export interface AdminSupportSuggestedAction {
    readonly code: string;
    readonly label: string;
    readonly severity: AdminSupportSuggestedActionSeverity;
    readonly operationRef?: string;
}

export interface AdminSupportClientTarget {
    readonly kind: 'client';
    readonly scope: StateScope;
    readonly principalId: PrincipalId;
    readonly clientInstanceId?: string;
    readonly sessionId?: SessionId;
}

export interface AdminSupportGroupTarget {
    readonly kind: 'group';
    readonly groupRef: GroupRef;
    readonly principalId?: PrincipalId;
    readonly sessionId?: SessionId;
}

export interface AdminSupportRequestTarget {
    readonly kind: 'request';
    readonly requestId?: string;
    readonly idempotencyKey?: string;
    readonly queueKey?: Key;
    readonly target?: AdminSupportJsonObject;
}

export interface AdminSupportCrdtDocumentTarget {
    readonly kind: 'crdt-document';
    readonly document: RallarCrdtDocumentRef;
}

export interface AdminSupportQueueItemTarget {
    readonly kind: 'queue-item';
    readonly queueKey: Key;
}

export type AdminSupportTarget =
    | AdminSupportClientTarget
    | AdminSupportGroupTarget
    | AdminSupportRequestTarget
    | AdminSupportCrdtDocumentTarget
    | AdminSupportQueueItemTarget;

export interface AdminSupportNarrativeResponse {
    readonly target: AdminSupportTarget;
    readonly generatedAtEpochMs: number;
    readonly serverId?: string;
    readonly facts: readonly AdminSupportFact[];
    readonly timeline: readonly AdminSupportTimelineItem[];
    readonly warnings: readonly AdminSupportWarning[];
    readonly likelyCauses: readonly string[];
    readonly suggestedActions: readonly AdminSupportSuggestedAction[];
    readonly rawRefs: readonly string[];
}

export interface AdminSupportExplainClientRequest {
    readonly scope: StateScope;
    readonly principalId: PrincipalId;
    readonly clientInstanceId?: string;
    readonly sessionId?: SessionId;
    readonly limitRecentEvents?: number;
}

export interface AdminSupportExplainGroupRequest {
    readonly groupRef: GroupRef;
    readonly principalId?: PrincipalId;
    readonly sessionId?: SessionId;
    readonly limitRecentEvents?: number;
}

export interface AdminSupportExplainRequestRequest {
    readonly requestId?: string;
    readonly idempotencyKey?: string;
    readonly queueKey?: Key;
    readonly target?: AdminSupportJsonObject;
}

export interface AdminSupportExplainCrdtDocumentRequest {
    readonly document: RallarCrdtDocumentRef;
    readonly includeIntegrity?: boolean;
    readonly includeRedactedDebugBundle?: boolean;
}

export interface AdminSupportExplainQueueItemRequest {
    readonly queueKey: Key;
    readonly includeExpired?: boolean;
}
