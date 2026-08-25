import type { AdminOperationMutationRequest } from '@shared-server/rallar-system/admin-operations/admin-operation-request.ts';
import type { CrdtAdminCompactResult } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

import type { CrdtAdminMutations, CrdtAdminPublicResult } from '../crdt/create-crdt-admin-mutations.ts';

export class CompactApiAdminCrdt {
    private readonly mutations: CrdtAdminMutations;

    constructor(mutations: CrdtAdminMutations) {
        this.mutations = mutations;
    }

    async execute(
        request: AdminOperationMutationRequest<JsonWireValue>
    ): Promise<CrdtAdminCompactResult> {
        const result = await this.mutations.writeCrdtAdminMutation({
            operation: 'compact',
            adminSession: request.adminSession,
            requestId: request.requestId,
            request: request.request
        });
        return requireCrdtCompactResult(result);
    }
}

function requireCrdtCompactResult(result: CrdtAdminPublicResult): CrdtAdminCompactResult {
    if ('snapshot' in result) {
        return result;
    }
    throw new TypeError('CRDT compact mutation returned a different operation result');
}
