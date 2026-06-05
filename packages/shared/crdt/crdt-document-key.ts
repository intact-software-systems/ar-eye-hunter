import type { RallarCrdtDocumentRef } from './crdt-types.ts';
import { canonicalRallarCrdtJson, hashRallarCrdtJson } from './crdt-hash.ts';

export function normalizeRallarCrdtDocumentRef(
    ref: RallarCrdtDocumentRef,
): Record<string, unknown> {
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId ?? null,
        scope: ref.scope,
        documentType: ref.documentType,
        documentId: ref.documentId,
        roomRef: ref.roomRef
            ? {
                  applicationId: ref.roomRef.applicationId,
                  workspaceId: ref.roomRef.workspaceId ?? null,
                  groupId: ref.roomRef.groupId,
              }
            : null,
        principalId: ref.principalId ?? null,
        customScope: ref.customScope ?? null,
    };
}

export function toRallarCrdtDocumentKey(ref: RallarCrdtDocumentRef): string {
    const normalized = normalizeRallarCrdtDocumentRef(ref);
    const readable = [
        normalized.applicationId,
        normalized.workspaceId,
        normalized.scope,
        normalized.documentType,
        normalized.documentId,
    ]
        .map((part) => encodeURIComponent(String(part ?? '')))
        .join(':');

    return ['crdt', 'v1', readable, hashRallarCrdtJson(normalized)].join(':');
}

export function canonicalRallarCrdtDocumentRef(
    ref: RallarCrdtDocumentRef,
): string {
    return canonicalRallarCrdtJson(normalizeRallarCrdtDocumentRef(ref));
}
