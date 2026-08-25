import type { RallarCrdtAdminReadRepository, RallarCrdtDebugBundle, RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';

import type { RallarTimingSink } from '../observability/timing.ts';
import type { AdminOperationWriteRequest } from './admin-operation-request.ts';
import { runTimedAdminOperation } from './run-timed-admin-operation.ts';

export namespace ExportAdminCrdtDebug {
    export interface Request {
        readonly document: RallarCrdtDocumentRef;
        readonly reason?: string;
        readonly redactPayloads?: boolean;
    }

    export interface Options {
        readonly serviceId?: string;
        readonly timing?: RallarTimingSink;
        readonly repository: Pick<RallarCrdtAdminReadRepository, 'exportDebugBundle'>;
    }
}

export class ExportAdminCrdtDebug {
    private readonly options: ExportAdminCrdtDebug.Options;

    constructor(options: ExportAdminCrdtDebug.Options) {
        this.options = options;
    }

    async execute(
        input: AdminOperationWriteRequest<ExportAdminCrdtDebug.Request>
    ): Promise<RallarCrdtDebugBundle> {
        const { document } = input.request;
        return await runTimedAdminOperation({
            timing: this.options.timing,
            event: {
                component: 'admin-operations',
                operation: 'crdt.debug-export',
                serviceId: this.options.serviceId,
                applicationId: document.applicationId,
                workspaceId: document.workspaceId,
                principalId: input.adminSession.clientId,
                sessionId: input.adminSession.sessionId,
                details: {
                    adminClientId: input.adminSession.clientId,
                    reason: input.request.reason,
                    documentScope: document.scope,
                    documentType: document.documentType,
                    documentId: document.documentId
                }
            },
            execute: async () =>
                await this.options.repository.exportDebugBundle(document, {
                    reason: input.request.reason ?? 'api-v1-admin-operations-debug-export',
                    redaction: input.request.redactPayloads === false
                        ? { payloadsRedacted: false }
                        : {
                            payloadsRedacted: true,
                            reason: 'api-v1-admin-operations-redaction'
                        }
                })
        });
    }
}
