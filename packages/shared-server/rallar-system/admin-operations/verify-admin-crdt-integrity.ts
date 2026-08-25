import type {
    RallarCrdtAdminReadRepository,
    RallarCrdtDocumentRef,
    RallarCrdtIntegrityReport
} from '@shared/crdt/mod.ts';

import type { RallarTimingSink } from '../observability/timing.ts';
import type { AdminOperationWriteRequest } from './admin-operation-request.ts';
import { runTimedAdminOperation } from './run-timed-admin-operation.ts';

export namespace VerifyAdminCrdtIntegrity {
    export interface Request {
        readonly document: RallarCrdtDocumentRef;
    }

    export interface Options {
        readonly serviceId?: string;
        readonly timing?: RallarTimingSink;
        readonly repository: Pick<RallarCrdtAdminReadRepository, 'verifyIntegrity'>;
    }
}

export class VerifyAdminCrdtIntegrity {
    private readonly options: VerifyAdminCrdtIntegrity.Options;

    constructor(options: VerifyAdminCrdtIntegrity.Options) {
        this.options = options;
    }

    async execute(
        input: AdminOperationWriteRequest<VerifyAdminCrdtIntegrity.Request>
    ): Promise<RallarCrdtIntegrityReport> {
        const { document } = input.request;
        return await runTimedAdminOperation({
            timing: this.options.timing,
            event: {
                component: 'admin-operations',
                operation: 'crdt.integrity',
                serviceId: this.options.serviceId,
                applicationId: document.applicationId,
                workspaceId: document.workspaceId,
                principalId: input.adminSession.clientId,
                sessionId: input.adminSession.sessionId,
                details: {
                    adminClientId: input.adminSession.clientId,
                    documentScope: document.scope,
                    documentType: document.documentType,
                    documentId: document.documentId
                }
            },
            execute: async () => await this.options.repository.verifyIntegrity(document)
        });
    }
}
