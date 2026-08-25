import type { AdminOperationMutationRequest } from '@shared-server/rallar-system/admin-operations/admin-operation-request.ts';
import type { CrdtAdminEraseResult } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

import type { CrdtAdminMutations, CrdtAdminPublicResult } from '../crdt/create-crdt-admin-mutations.ts';

export class EraseApiAdminCrdt {
    private readonly mutations: CrdtAdminMutations;

    constructor(mutations: CrdtAdminMutations) {
        this.mutations = mutations;
    }

    async execute(
        request: AdminOperationMutationRequest<JsonWireValue>
    ): Promise<CrdtAdminEraseResult> {
        const result = await this.mutations.writeCrdtAdminMutation({
            operation: 'erase',
            adminSession: request.adminSession,
            requestId: request.requestId,
            request: request.request
        });
        return requireCrdtEraseResult(result);
    }
}

function requireCrdtEraseResult(result: CrdtAdminPublicResult): CrdtAdminEraseResult {
    if ('request' in result) {
        return result;
    }
    throw new TypeError('CRDT erase mutation returned a different operation result');
}
