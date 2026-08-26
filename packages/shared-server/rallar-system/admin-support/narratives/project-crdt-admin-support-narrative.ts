import type {
    AdminSupportExplainCrdtDocumentRequest,
    AdminSupportFact,
    AdminSupportNarrativeResponse,
    AdminSupportSuggestedAction,
    AdminSupportTimelineItem,
    AdminSupportWarning
} from '@shared/api/admin-support/admin-support-types.ts';
import type {
    RallarCrdtDebugBundle,
    RallarCrdtDocumentMetadata,
    RallarCrdtDocumentRef,
    RallarCrdtIntegrityReport
} from '@shared/crdt/mod.ts';
import { adminSupportNarrativeBase, type AdminSupportNarrativeBase } from './admin-support-narrative-base.ts';
import { toAdminSupportTimelineItem } from './admin-support-timeline.ts';

interface ProjectCrdtAdminSupportInput extends AdminSupportNarrativeBase {
    readonly request: AdminSupportExplainCrdtDocumentRequest;
    readonly hasRepository: boolean;
    readonly hasMetadataReader: boolean;
    readonly hasIntegrityReader: boolean;
    readonly hasDebugBundleReader: boolean;
    readonly metadata: RallarCrdtDocumentMetadata | undefined;
    readonly integrity: RallarCrdtIntegrityReport | undefined;
    readonly debugBundle: RallarCrdtDebugBundle | undefined;
}

export function projectCrdtAdminSupportNarrative(
    input: ProjectCrdtAdminSupportInput
): AdminSupportNarrativeResponse {
    const facts = crdtFacts(input);
    const warnings = crdtWarnings({
        hasRepository: input.hasRepository,
        hasMetadataReader: input.hasMetadataReader,
        requestedIntegrity: input.request.includeIntegrity === true,
        hasIntegrityReader: input.hasIntegrityReader,
        requestedDebugBundle: input.request.includeRedactedDebugBundle === true,
        hasDebugBundleReader: input.hasDebugBundleReader,
        metadata: input.metadata,
        integrity: input.integrity
    });
    return {
        ...adminSupportNarrativeBase(input, {
            kind: 'crdt-document',
            document: input.request.document
        }),
        facts,
        timeline: crdtTimeline(input.metadata),
        warnings,
        likelyCauses: crdtLikelyCauses(input.metadata, input.integrity),
        suggestedActions: crdtSuggestedActions(input.metadata, input.integrity),
        rawRefs: [
            input.metadata
                ? `crdt:${input.metadata.documentKey}`
                : `crdt:${toDocumentRef(input.request.document)}`
        ]
    };
}

interface CrdtFactsInput {
    readonly metadata: RallarCrdtDocumentMetadata | undefined;
    readonly integrity: RallarCrdtIntegrityReport | undefined;
    readonly debugBundle: RallarCrdtDebugBundle | undefined;
}

interface CrdtWarningsInput {
    readonly hasRepository: boolean;
    readonly hasMetadataReader: boolean;
    readonly requestedIntegrity: boolean;
    readonly hasIntegrityReader: boolean;
    readonly requestedDebugBundle: boolean;
    readonly hasDebugBundleReader: boolean;
    readonly metadata: RallarCrdtDocumentMetadata | undefined;
    readonly integrity: RallarCrdtIntegrityReport | undefined;
}

function crdtFacts(input: CrdtFactsInput): readonly AdminSupportFact[] {
    const facts: AdminSupportFact[] = [
        {
            label: 'crdt.metadata',
            source: 'crdt-admin-log',
            value: input.metadata ? 'found' : 'missing',
            certainty: input.metadata ? 'exact' : 'unavailable'
        }
    ];

    if (input.metadata) {
        facts.push(
            {
                label: 'crdt.lifecycle',
                source: 'crdt-admin-log',
                value: input.metadata.lifecycle,
                certainty: 'exact'
            },
            {
                label: 'crdt.updateCount',
                source: 'crdt-admin-log',
                value: input.metadata.updateCount,
                certainty: 'exact'
            },
            {
                label: 'crdt.snapshotCount',
                source: 'crdt-admin-log',
                value: input.metadata.snapshotCount,
                certainty: 'exact'
            },
            {
                label: 'crdt.lastAppendSequence',
                source: 'crdt-admin-log',
                value: input.metadata.lastAppendSequence,
                certainty: 'exact'
            }
        );
    }

    if (input.integrity) {
        facts.push(
            {
                label: 'crdt.integrity.valid',
                source: 'crdt-admin-log',
                value: input.integrity.valid,
                certainty: 'exact'
            },
            {
                label: 'crdt.integrity.checkedUpdateCount',
                source: 'crdt-admin-log',
                value: input.integrity.checkedUpdateCount,
                certainty: 'exact'
            },
            {
                label: 'crdt.integrity.sequenceGaps',
                source: 'crdt-admin-log',
                value: input.integrity.sequenceGaps,
                certainty: 'exact'
            }
        );
    }

    if (input.debugBundle) {
        facts.push({
            label: 'crdt.debugExport',
            source: 'crdt-admin-log',
            value: {
                format: input.debugBundle.format,
                recordCount: input.debugBundle.records.length,
                payloadsRedacted: input.debugBundle.redaction.payloadsRedacted,
                updateCount: input.debugBundle.integrity.updateCount
            },
            certainty: 'exact',
            redacted: true
        });
    }

    return facts;
}

function crdtTimeline(
    metadata: RallarCrdtDocumentMetadata | undefined
): readonly AdminSupportTimelineItem[] {
    if (!metadata) {
        return [];
    }
    return [
        toAdminSupportTimelineItem({
            atEpochMs: metadata.createdAtEpochMs,
            source: 'crdt-admin-log',
            eventType: 'crdt.created',
            summary: 'CRDT document metadata was created.'
        }),
        toAdminSupportTimelineItem({
            atEpochMs: metadata.updatedAtEpochMs,
            source: 'crdt-admin-log',
            eventType: 'crdt.updated',
            summary: 'CRDT document metadata was updated.'
        }),
        toAdminSupportTimelineItem({
            atEpochMs: metadata.archivedAtEpochMs ?? undefined,
            source: 'crdt-admin-log',
            eventType: 'crdt.archived',
            summary: 'CRDT document was archived.'
        }),
        toAdminSupportTimelineItem({
            atEpochMs: metadata.destroyedAtEpochMs ?? undefined,
            source: 'crdt-admin-log',
            eventType: 'crdt.destroyed',
            summary: 'CRDT document was destroyed.'
        })
    ].filter((item): item is AdminSupportTimelineItem => item !== undefined);
}

function crdtWarnings(input: CrdtWarningsInput): readonly AdminSupportWarning[] {
    const warnings: AdminSupportWarning[] = [];
    if (!input.hasRepository) {
        warnings.push({
            code: 'crdt-repository-unconfigured',
            message: 'CRDT admin repository is not configured for support explanation.',
            source: 'admin-support'
        });
    }
    if (input.hasRepository && !input.hasMetadataReader) {
        warnings.push({
            code: 'crdt-metadata-reader-unavailable',
            message: 'CRDT metadata reader is not available.',
            source: 'crdt-admin-log'
        });
    }
    if (input.hasMetadataReader && !input.metadata) {
        warnings.push({
            code: 'crdt-metadata-missing',
            message: 'No CRDT document metadata was found.',
            source: 'crdt-admin-log'
        });
    }
    if (input.requestedIntegrity && !input.hasIntegrityReader) {
        warnings.push({
            code: 'crdt-integrity-reader-unavailable',
            message: 'CRDT integrity verification is not available.',
            source: 'crdt-admin-log'
        });
    }
    if (input.integrity && !input.integrity.valid) {
        warnings.push({
            code: 'crdt-integrity-invalid',
            message: 'CRDT integrity verification reported validation issues.',
            source: 'crdt-admin-log'
        });
    }
    if (input.requestedDebugBundle && !input.hasDebugBundleReader) {
        warnings.push({
            code: 'crdt-debug-export-unavailable',
            message: 'CRDT debug export is not available.',
            source: 'crdt-admin-log'
        });
    }
    return warnings;
}

function crdtLikelyCauses(
    metadata: RallarCrdtDocumentMetadata | undefined,
    integrity: RallarCrdtIntegrityReport | undefined
): readonly string[] {
    const causes = [];
    if (!metadata) {
        causes.push('CRDT document has no durable metadata.');
    }
    if (integrity && !integrity.valid) {
        causes.push('CRDT durable log integrity check found validation issues.');
    }
    return causes;
}

function crdtSuggestedActions(
    metadata: RallarCrdtDocumentMetadata | undefined,
    integrity: RallarCrdtIntegrityReport | undefined
): readonly AdminSupportSuggestedAction[] {
    const actions: AdminSupportSuggestedAction[] = [];
    if (!metadata) {
        actions.push({
            code: 'verify-crdt-document-ref',
            label: 'Verify CRDT document scope, type, and id',
            severity: 'info'
        });
    }
    if (integrity && !integrity.valid) {
        actions.push({
            code: 'inspect-crdt-debug-export',
            label: 'Inspect a redacted CRDT debug export before repair',
            severity: 'warning',
            operationRef: 'admin-operations.crdt.debug-export'
        });
    }
    return actions;
}

function toDocumentRef(document: RallarCrdtDocumentRef): string {
    return [
        document.applicationId,
        document.workspaceId ?? '_',
        document.scope,
        document.documentType,
        document.documentId
    ].join('/');
}
