import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import type { RallarCrdtDocumentRef } from '@shared/crdt/crdt-types.ts';

export type CrdtAdminOperatorMutationAction = 'archive' | 'compact' | 'destroy' | 'quarantine' | 'rebuild';

export interface CrdtAdminOperatorMutationInput {
    readonly action: CrdtAdminOperatorMutationAction;
    readonly changedAtEpochMs: number;
    readonly document: RallarCrdtDocumentRef;
    readonly requestId: string;
}

export interface CrdtAdminOperatorMutationRequest {
    readonly path: string;
    readonly body: CrdtAdminOperatorMutationBody;
}

type CrdtAdminOperatorMutationBody =
    | Readonly<{
        document: RallarCrdtDocumentRef;
        reason: string;
    }>
    | Readonly<{
        document: RallarCrdtDocumentRef;
        projectionId: string;
    }>
    | Readonly<{
        document: RallarCrdtDocumentRef;
        lifecycle: 'archived' | 'quarantined';
        changedAtEpochMs: number;
    }>
    | Readonly<{
        document: RallarCrdtDocumentRef;
        mode: 'destroy-document';
        reason: string;
    }>;

export function isCrdtAdminOperatorMutationAction(
    action: string
): action is CrdtAdminOperatorMutationAction {
    return ['archive', 'compact', 'destroy', 'quarantine', 'rebuild'].includes(action);
}

export function toCrdtAdminOperatorMutationRequest(
    input: CrdtAdminOperatorMutationInput
): CrdtAdminOperatorMutationRequest {
    const document = { document: input.document };
    switch (input.action) {
        case 'compact':
            return mutationRequest('/api/crdt/admin/documents/compact', input.requestId, {
                ...document,
                reason: 'black-box-crdt-health-compaction'
            });
        case 'rebuild':
            return mutationRequest('/api/crdt/admin/documents/rebuild-projection', input.requestId, {
                ...document,
                projectionId: 'black-box-health'
            });
        case 'archive':
        case 'quarantine':
            return mutationRequest('/api/crdt/admin/documents/lifecycle', input.requestId, {
                ...document,
                lifecycle: input.action === 'archive' ? 'archived' : 'quarantined',
                changedAtEpochMs: input.changedAtEpochMs
            });
        case 'destroy':
            return mutationRequest('/api/crdt/admin/documents/erase', input.requestId, {
                ...document,
                mode: 'destroy-document',
                reason: 'black-box-crdt-health-destroy'
            });
    }
}

function mutationRequest(
    path: string,
    requestId: string,
    body: CrdtAdminOperatorMutationBody
): CrdtAdminOperatorMutationRequest {
    return {
        path: toApiMutationRequestPath(path, requestId),
        body
    };
}
