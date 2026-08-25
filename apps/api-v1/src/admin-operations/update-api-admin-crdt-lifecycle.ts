import type { AdminOperationMutationRequest } from '@shared-server/rallar-system/admin-operations/admin-operation-request.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { RallarCrdtDocumentMetadata } from '@shared/crdt/mod.ts';

import type { CrdtAdminMutations, CrdtAdminPublicResult } from '../crdt/create-crdt-admin-mutations.ts';

export class UpdateApiAdminCrdtLifecycle {
    private readonly mutations: CrdtAdminMutations;

    constructor(mutations: CrdtAdminMutations) {
        this.mutations = mutations;
    }

    async execute(
        request: AdminOperationMutationRequest<JsonWireValue>
    ): Promise<RallarCrdtDocumentMetadata> {
        const result = await this.mutations.writeCrdtAdminMutation({
            operation: 'lifecycle',
            adminSession: request.adminSession,
            requestId: request.requestId,
            request: request.request
        });
        return requireCrdtLifecycleResult(result);
    }
}

function requireCrdtLifecycleResult(result: CrdtAdminPublicResult): RallarCrdtDocumentMetadata {
    if ('lifecycle' in result) {
        return result;
    }
    throw new TypeError('CRDT lifecycle mutation returned a different operation result');
}
