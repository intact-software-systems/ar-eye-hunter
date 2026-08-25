import type { AdminOperationMutationRequest } from '@shared-server/rallar-system/admin-operations/admin-operation-request.ts';
import type { AppAdminInboxService } from '@shared-server/rallar-system/admin-operations/inbox/app-admin-inbox-service.ts';
import type { AdminPruneExpiredRequest } from '@shared/api/admin-operations-types.ts';

export namespace PruneApiAdminExpiredData {
    export interface Options {
        readonly appAdminInbox: Pick<AppAdminInboxService, 'pruneExpired'>;
    }
}

export class PruneApiAdminExpiredData {
    private readonly options: PruneApiAdminExpiredData.Options;

    constructor(options: PruneApiAdminExpiredData.Options) {
        this.options = options;
    }

    async execute(input: AdminOperationMutationRequest<AdminPruneExpiredRequest>) {
        const result = await this.options.appAdminInbox.pruneExpired(input);
        if (result.right !== undefined) {
            return result.right;
        }
        if (result.left !== undefined) {
            throw Object.assign(new Error(result.left.message), {
                code: result.left.code,
                status: result.left.status,
                failure: result.left
            });
        }
        throw new Error('Admin prune AppInbox processing failed');
    }
}
