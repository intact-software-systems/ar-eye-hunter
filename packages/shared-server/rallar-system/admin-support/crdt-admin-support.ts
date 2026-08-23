import type {
    AdminSupportExplainCrdtDocumentRequest,
    AdminSupportNarrativeResponse
} from '@shared/api/admin-support-types.ts';
import type { AdminSupportWriteInput, CrdtAdminSupportDependencies } from './admin-support-contracts.ts';
import { executeAdminSupportUseCase } from './execute-admin-support-use-case.ts';
import { projectCrdtAdminSupportNarrative } from './narratives/project-crdt-admin-support-narrative.ts';

export class CrdtAdminSupport {
    private readonly dependencies: CrdtAdminSupportDependencies;

    public constructor(dependencies: CrdtAdminSupportDependencies) {
        this.dependencies = dependencies;
    }

    public async explainCrdtDocument(
        input: AdminSupportWriteInput<AdminSupportExplainCrdtDocumentRequest>
    ): Promise<AdminSupportNarrativeResponse> {
        return await executeAdminSupportUseCase(
            this.dependencies,
            'explain.crdt-document',
            input,
            async () => {
                const repository = this.dependencies.crdtAdminRepository;
                const metadata = await repository?.readDocumentMetadata?.(
                    input.request.document
                );
                const integrity = input.request.includeIntegrity === true
                    ? await repository?.verifyIntegrity?.(input.request.document)
                    : undefined;
                const debugBundle = input.request.includeRedactedDebugBundle === true
                    ? await repository?.exportDebugBundle?.(input.request.document, {
                        reason: 'api-v1-admin-support-debug-export',
                        exportedAtEpochMs: this.dependencies.now(),
                        redaction: {
                            payloadsRedacted: true,
                            reason: 'api-v1-admin-support-redaction'
                        }
                    })
                    : undefined;
                return projectCrdtAdminSupportNarrative({
                    request: input.request,
                    generatedAtEpochMs: this.dependencies.now(),
                    serverId: this.dependencies.serverId,
                    hasRepository: Boolean(repository),
                    hasMetadataReader: Boolean(repository?.readDocumentMetadata),
                    hasIntegrityReader: Boolean(repository?.verifyIntegrity),
                    hasDebugBundleReader: Boolean(repository?.exportDebugBundle),
                    metadata,
                    integrity,
                    debugBundle
                });
            }
        );
    }
}
